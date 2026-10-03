import { Result } from "@verixa/shared-kernel";
import { describe, expect, it, vi } from "vitest";

import { AuditLogEntry, type AuditAction } from "../../domain/entities/audit-log-entry.js";
import { InMemoryAuditLogRepository } from "../../infrastructure/testing/in-memory-audit-repositories.js";
import type { AuditLogRepository, FindWithFiltersParams } from "../ports/audit-log-repository.js";

import {
  ExportAuditEvents,
  escapeCsvField,
  type ExportAuditEventsFormat,
} from "./export-audit-events.js";

interface EntryOverrides {
  readonly action?: AuditAction;
  readonly actorId?: string;
  readonly subjectId?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly occurredAt?: Date;
}

function makeEntry(
  previous: AuditLogEntry | undefined,
  overrides: EntryOverrides = {},
): AuditLogEntry {
  return AuditLogEntry.append({
    action: overrides.action ?? "user.login_succeeded",
    actorId: overrides.actorId,
    subjectId: overrides.subjectId,
    metadata: overrides.metadata ?? {},
    occurredAt: overrides.occurredAt ?? new Date("2026-01-01T00:00:00.000Z"),
    previous,
  });
}

async function seed(
  repository: InMemoryAuditLogRepository,
  count: number,
  overrides: (index: number) => EntryOverrides = () => ({}),
): Promise<AuditLogEntry[]> {
  const entries: AuditLogEntry[] = [];
  let previous: AuditLogEntry | undefined;

  for (let index = 0; index < count; index += 1) {
    previous = makeEntry(previous, overrides(index));
    await repository.append(previous);
    entries.push(previous);
  }

  return entries;
}

async function collect(iterable: AsyncIterable<string>): Promise<string> {
  let output = "";
  for await (const chunk of iterable) {
    output += chunk;
  }
  return output;
}

/** Minimal RFC 4180 reader, sufficient to prove the writer round-trips. */
function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input.charAt(index);

    if (inQuotes) {
      if (char === '"') {
        if (input.charAt(index + 1) === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function execute(
  useCase: ExportAuditEvents,
  command: {
    format: ExportAuditEventsFormat;
    batchSize?: number;
    filters?: FindWithFiltersParams["filters"];
  },
): AsyncIterable<string> {
  const result = useCase.execute(command);
  if (Result.isErr(result)) throw new Error(`expected ok, got ${result.error.message}`);
  return result.value;
}

/**
 * A repository that never runs out of entries. If the export buffered the
 * whole log before yielding, consuming it would hang forever — which is
 * exactly the property the streaming design must rule out.
 */
class EndlessAuditLogRepository implements AuditLogRepository {
  calls = 0;

  findLatest(): Promise<AuditLogEntry | undefined> {
    return Promise.resolve(undefined);
  }

  append(): Promise<void> {
    return Promise.resolve();
  }

  findFrom(): Promise<readonly AuditLogEntry[]> {
    return Promise.resolve([]);
  }

  findWithFilters(params: FindWithFiltersParams): Promise<readonly AuditLogEntry[]> {
    this.calls += 1;
    const page = Array.from({ length: params.limit }, (_unused, offset) =>
      makeEntry(undefined, { actorId: `actor-${String(params.fromSequence + offset)}` }),
    );
    return Promise.resolve(page);
  }

  count(): Promise<number> {
    return Promise.resolve(Number.MAX_SAFE_INTEGER);
  }
}

describe("ExportAuditEvents", () => {
  describe("validation", () => {
    it("rejects an unsupported format without touching the repository", () => {
      const repository = new InMemoryAuditLogRepository();
      const result = new ExportAuditEvents(repository).execute({
        format: "xml" as ExportAuditEventsFormat,
      });

      expect(Result.isErr(result)).toBe(true);
      if (Result.isErr(result)) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
      }
    });

    it.each([0, -1, 1.5])("rejects a non-positive batchSize (%s)", (batchSize) => {
      const result = new ExportAuditEvents(new InMemoryAuditLogRepository()).execute({
        format: "csv",
        batchSize,
      });

      expect(Result.isErr(result)).toBe(true);
    });
  });

  describe("CSV", () => {
    it("writes a header followed by one row per entry", async () => {
      const repository = new InMemoryAuditLogRepository();
      const entries = await seed(repository, 2, (index) => ({
        actorId: `actor-${String(index)}`,
        subjectId: `subject-${String(index)}`,
      }));

      const csv = await collect(execute(new ExportAuditEvents(repository), { format: "csv" }));
      const rows = parseCsv(csv);

      expect(rows[0]).toEqual([
        "sequence",
        "id",
        "action",
        "actorId",
        "subjectId",
        "occurredAt",
        "metadata",
        "previousHash",
        "hash",
      ]);
      expect(rows).toHaveLength(3);
      expect(rows[1]![0]).toBe("1");
      expect(rows[1]![1]).toBe(String(entries[0]!.id));
      expect(rows[1]![2]).toBe("user.login_succeeded");
      expect(rows[1]![3]).toBe("actor-0");
      expect(rows[1]![5]).toBe("2026-01-01T00:00:00.000Z");
      expect(rows[1]![8]).toBe(entries[0]!.hash);
    });

    it("round-trips metadata containing delimiters, quotes and newlines", async () => {
      const repository = new InMemoryAuditLogRepository();
      const metadata = {
        note: 'a,b"c\nd',
        quote: 'say "hi"',
        carriage: "line\rbreak",
        plain: "ok",
      };
      await seed(repository, 1, () => ({ metadata }));

      const csv = await collect(execute(new ExportAuditEvents(repository), { format: "csv" }));
      const rows = parseCsv(csv);

      expect(rows).toHaveLength(2);
      expect(JSON.parse(rows[1]![6]!)).toEqual(metadata);
    });
  });

  describe("JSON", () => {
    it("writes newline-delimited JSON, one valid object per line", async () => {
      const repository = new InMemoryAuditLogRepository();
      const entries = await seed(repository, 2, (index) => ({
        metadata: { index: String(index) },
      }));

      const json = await collect(execute(new ExportAuditEvents(repository), { format: "json" }));
      const lines = json.split("\n").filter((line) => line.length > 0);

      expect(lines).toHaveLength(2);
      expect(lines[0]![0]).toBe("{");

      const first = JSON.parse(lines[0]!) as Record<string, unknown>;
      expect(first["sequence"]).toBe(1);
      expect(first["id"]).toBe(String(entries[0]!.id));
      expect(first["action"]).toBe("user.login_succeeded");
      expect(first["metadata"]).toEqual({ index: "0" });
      expect(first["occurredAt"]).toBe("2026-01-01T00:00:00.000Z");
    });

    it("represents an absent actor as null rather than dropping the field", async () => {
      const repository = new InMemoryAuditLogRepository();
      await seed(repository, 1);

      const json = await collect(execute(new ExportAuditEvents(repository), { format: "json" }));
      const record = JSON.parse(json.trim()) as Record<string, unknown>;

      expect(record["actorId"]).toBeNull();
      expect(record["subjectId"]).toBeNull();
    });
  });

  describe("filtering", () => {
    it("reuses the query filters so an export mirrors the in-app query", async () => {
      const repository = new InMemoryAuditLogRepository();
      await seed(repository, 3, (index) => ({
        actorId: index === 1 ? "bob" : "alice",
        action: index === 0 ? "user.login_succeeded" : "user.login_failed",
        occurredAt: new Date(`2026-01-0${String(index + 1)}T00:00:00.000Z`),
      }));

      const byActor = await collect(
        execute(new ExportAuditEvents(repository), {
          format: "csv",
          filters: { actorId: "alice" },
        }),
      );
      expect(parseCsv(byActor)).toHaveLength(3);

      const byDate = await collect(
        execute(new ExportAuditEvents(repository), {
          format: "json",
          filters: { fromDate: new Date("2026-01-02T00:00:00.000Z") },
        }),
      );
      expect(byDate.split("\n").filter((line) => line.length > 0)).toHaveLength(2);
    });
  });

  describe("streaming", () => {
    it("yields the first row without draining the rest of the log", async () => {
      const repository = new EndlessAuditLogRepository();
      const stream = execute(new ExportAuditEvents(repository), { format: "csv", batchSize: 10 })[
        Symbol.asyncIterator
      ]();

      const header = await stream.next();
      expect(repository.calls).toBe(0);
      expect(header.value).toContain("sequence");

      const timeout = new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error("export buffered an endless log before yielding"));
        }, 1_000);
      });

      const first = await Promise.race([stream.next(), timeout]);
      expect(repository.calls).toBe(1);
      expect(first.value).toContain("actor-1");

      await stream.return?.(undefined);
    });

    it("pages through a large log in bounded batches", async () => {
      const repository = new InMemoryAuditLogRepository();
      const total = 1_000;
      await seed(repository, total);
      const spy = vi.spyOn(repository, "findWithFilters");

      const json = await collect(
        execute(new ExportAuditEvents(repository), { format: "json", batchSize: 100 }),
      );

      expect(json.split("\n").filter((line) => line.length > 0)).toHaveLength(total);

      const batchSizes = spy.mock.calls.map(([params]) => params.limit);
      expect(Math.max(...batchSizes)).toBe(100);
      expect(spy).toHaveBeenCalledTimes(total / 100 + 1);
    });
  });
});

describe("escapeCsvField", () => {
  it("leaves an ordinary value untouched", () => {
    expect(escapeCsvField("plain")).toBe("plain");
  });

  it.each([
    ["a,b", '"a,b"'],
    ['a"b', '"a""b"'],
    ["a\nb", '"a\nb"'],
    ["a\rb", '"a\rb"'],
  ])("quotes and escapes %j", (value, expected) => {
    expect(escapeCsvField(value)).toBe(expected);
  });
});
