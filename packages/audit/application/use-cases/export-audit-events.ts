import { Result, ValidationError } from "@verixa/shared-kernel";

import type { AuditLogEntry } from "../../domain/entities/audit-log-entry.js";
import type { AuditLogFilters, AuditLogRepository } from "../ports/audit-log-repository.js";

/** The portable formats a compliance export can be produced in. */
export type ExportAuditEventsFormat = "csv" | "json";

export interface ExportAuditEventsCommand {
  readonly format: ExportAuditEventsFormat;
  /**
   * The same filters `QueryAuditEvents` accepts (Issue 187). Reused rather
   * than redefined so the export and the in-app query can never drift apart:
   * an export that filtered differently from the query it is meant to mirror
   * would be a compliance bug that tests would have to catch twice.
   */
  readonly filters?: AuditLogFilters;
  /**
   * Entries fetched per repository round-trip. Bounds peak memory: only one
   * page is ever held at a time, regardless of how large the log is.
   */
  readonly batchSize?: number;
}

export type ExportAuditEventsError = ValidationError;

/** One row of the export, flattened from {@link AuditLogEntry}. */
interface AuditExportRecord {
  readonly sequence: number;
  readonly id: string;
  readonly action: string;
  readonly actorId: string | null;
  readonly subjectId: string | null;
  readonly occurredAt: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly previousHash: string;
  readonly hash: string;
}

const DEFAULT_BATCH_SIZE = 500;

const CSV_COLUMNS = [
  "sequence",
  "id",
  "action",
  "actorId",
  "subjectId",
  "occurredAt",
  "metadata",
  "previousHash",
  "hash",
] as const;

/**
 * Exports the audit log as a stream of CSV or JSON text.
 *
 * ## Streaming, not buffering
 *
 * The obvious implementation — query every matching entry, build one big
 * string, return it — works beautifully until it doesn't. A compliance
 * export is exactly the kind of operation that runs against a log that has
 * been accumulating for years, and buffering it means peak memory grows with
 * the size of the history being exported. A few hundred thousand entries is
 * enough to exhaust a small container, and the failure is an out-of-memory
 * kill in the middle of an audited export, which is the worst possible time
 * to discover it.
 *
 * So this returns an async iterable and fetches the log one bounded page at
 * a time. Callers write each chunk straight to the response body (or a file
 * stream, or object storage), and peak memory stays flat no matter how many
 * entries match. The cost is that the caller *must* consume the iterable:
 * there is no "give me the whole thing" convenience, because that is the
 * behaviour this design exists to prevent.
 *
 * ## JSON is newline-delimited, not an array
 *
 * Both formats were allowed "per a documented choice". NDJSON (one JSON
 * object per line) is the choice, because it is the one that composes with
 * streaming: an array would require holding the opening bracket, writing a
 * comma before every element after the first, and closing the bracket at the
 * end — bookkeeping that only exists to satisfy a format, not to convey
 * anything. NDJSON is also what downstream tools actually want: `jq`,
 * `grep`, and log pipelines all consume it line by line. The one thing an
 * array buys is being a single valid JSON document, which is a real
 * difference and worth knowing; if a consumer needs that, wrapping the
 * stream is a one-line transformation at the edge.
 *
 * ## CSV escaping
 *
 * Metadata is the attacker-controlled field. It is serialised to JSON first
 * (so a value containing a comma, quote or newline cannot break out of its
 * cell) and then the whole JSON string is quoted and its quotes doubled per
 * RFC 4180. Two layers, because "just join with commas" is precisely the
 * injection the audit-log metadata issue warns about.
 */
export class ExportAuditEvents {
  constructor(private readonly repository: AuditLogRepository) {}

  execute(
    command: ExportAuditEventsCommand,
  ): Result<AsyncIterable<string>, ExportAuditEventsError> {
    const batchSize = command.batchSize ?? DEFAULT_BATCH_SIZE;

    if (!Number.isInteger(batchSize) || batchSize <= 0) {
      return Result.err(
        new ValidationError("batchSize must be a positive integer.", {
          batchSize: ["must be a positive integer"],
        }),
      );
    }

    if (command.format !== "csv" && command.format !== "json") {
      return Result.err(
        new ValidationError(`Unsupported export format "${String(command.format)}".`, {
          format: ["must be one of: csv, json"],
        }),
      );
    }

    const filters = command.filters ?? {};

    return Result.ok(
      command.format === "csv"
        ? this.streamCsv(filters, batchSize)
        : this.streamJson(filters, batchSize),
    );
  }

  private async *streamCsv(
    filters: AuditLogFilters,
    batchSize: number,
  ): AsyncGenerator<string, void, undefined> {
    yield `${CSV_COLUMNS.join(",")}\n`;

    for await (const entry of this.streamEntries(filters, batchSize)) {
      yield `${toCsvRow(entry)}\n`;
    }
  }

  private async *streamJson(
    filters: AuditLogFilters,
    batchSize: number,
  ): AsyncGenerator<string, void, undefined> {
    for await (const entry of this.streamEntries(filters, batchSize)) {
      yield `${JSON.stringify(toExportRecord(entry))}\n`;
    }
  }

  /**
   * Walks the filtered log in keyset order, one bounded page at a time.
   *
   * The page size is the memory ceiling: nothing above this ever holds more
   * than `batchSize` entries. A short page means the filter is exhausted, so
   * the loop stops; a full page means "there may be more" and the cursor
   * advances past the last sequence seen. Filtering happens inside the
   * repository, before the page limit, which is what makes "short page =
   * done" true even when many entries between cursor positions are excluded.
   */
  private async *streamEntries(
    filters: AuditLogFilters,
    batchSize: number,
  ): AsyncGenerator<AuditLogEntry, void, undefined> {
    let cursor = 0;

    for (;;) {
      const page = await this.repository.findWithFilters({
        filters,
        fromSequence: cursor + 1,
        limit: batchSize,
      });

      for (const entry of page) {
        yield entry;
      }

      if (page.length < batchSize) {
        return;
      }

      cursor = page[page.length - 1]!.sequence;
    }
  }
}

function toExportRecord(entry: AuditLogEntry): AuditExportRecord {
  return {
    sequence: entry.sequence,
    id: String(entry.id),
    action: entry.action,
    actorId: entry.actorId ?? null,
    subjectId: entry.subjectId ?? null,
    occurredAt: entry.occurredAt.toISOString(),
    metadata: entry.metadata,
    previousHash: entry.previousHash,
    hash: entry.hash,
  };
}

function toCsvRow(entry: AuditLogEntry): string {
  const fields = [
    String(entry.sequence),
    String(entry.id),
    entry.action,
    entry.actorId ?? "",
    entry.subjectId ?? "",
    entry.occurredAt.toISOString(),
    JSON.stringify(entry.metadata),
    entry.previousHash,
    entry.hash,
  ];

  return fields.map(escapeCsvField).join(",");
}

/**
 * RFC 4180 field escaping: wrap in double quotes and double any quotes
 * inside when the value contains a delimiter, quote or line break; leave it
 * bare otherwise.
 */
export function escapeCsvField(value: string): string {
  if (value.includes('"') || value.includes(",") || value.includes("\n") || value.includes("\r")) {
    return `"${value.replace(/"/g, '""')}"`;
  }

  return value;
}
