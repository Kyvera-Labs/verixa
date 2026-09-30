import type {
  AuditEventCriteria,
  AuditEventPage,
  AuditEventReader,
} from "../../application/ports/audit-event-reader.js";
import type {
  AnchorRecord,
  AnchorRecordRepository,
  AuditLogRepository,
} from "../../application/ports/audit-log-repository.js";
import type { AuditLogEntry } from "../../domain/entities/audit-log-entry.js";

/**
 * In-memory `AuditLogRepository` for testing without a database.
 *
 * Enforces the sequence uniqueness the real table enforces with an index.
 * That matters more than usual here: the whole append protocol depends on a
 * duplicate sequence being rejected, and a fake that accepted one would let
 * tests pass against a forked chain that production would have refused.
 */
export class InMemoryAuditLogRepository implements AuditLogRepository {
  private readonly entries: AuditLogEntry[] = [];

  findLatest(): Promise<AuditLogEntry | undefined> {
    return Promise.resolve(this.entries.at(-1));
  }

  append(entry: AuditLogEntry): Promise<void> {
    if (this.entries.some((existing) => existing.sequence === entry.sequence)) {
      return Promise.reject(
        new Error(`An audit entry with sequence ${String(entry.sequence)} already exists.`),
      );
    }
    this.entries.push(entry);
    return Promise.resolve();
  }

  findFrom(fromSequence: number, limit: number): Promise<readonly AuditLogEntry[]> {
    return Promise.resolve(
      this.entries.filter((entry) => entry.sequence >= fromSequence).slice(0, limit),
    );
  }

  count(): Promise<number> {
    return Promise.resolve(this.entries.length);
  }

  /**
   * Test-only: replaces an entry, simulating tampering.
   *
   * Deliberately absent from `AuditLogRepository`, because the port must not
   * offer a way to break append-only. It exists here so verification tests can
   * prove the chain actually detects a rewrite — a guarantee nothing else
   * could demonstrate.
   */
  tamper(sequence: number, replacement: AuditLogEntry): void {
    const index = this.entries.findIndex((entry) => entry.sequence === sequence);
    if (index >= 0) this.entries[index] = replacement;
  }

  /** Test-only: removes an entry, simulating deletion. */
  remove(sequence: number): void {
    const index = this.entries.findIndex((entry) => entry.sequence === sequence);
    if (index >= 0) this.entries.splice(index, 1);
  }

  /** Test-only: every entry, in order. */
  all(): readonly AuditLogEntry[] {
    return [...this.entries];
  }
}

/** In-memory `AnchorRecordRepository` for testing without a database. */
export class InMemoryAnchorRecordRepository implements AnchorRecordRepository {
  private readonly records: AnchorRecord[] = [];

  save(record: AnchorRecord): Promise<void> {
    this.records.push(record);
    return Promise.resolve();
  }

  findLatest(): Promise<AnchorRecord | undefined> {
    return Promise.resolve(this.records.at(-1));
  }

  findAll(limit: number): Promise<readonly AnchorRecord[]> {
    return Promise.resolve([...this.records].reverse().slice(0, limit));
  }
}

/**
 * In-memory `AuditEventReader` for testing without a database.
 *
 * Entries are filed under an organization explicitly with {@link seed}, since
 * `AuditLogEntry` does not carry one yet (Issue 181). Every read is recorded in
 * {@link reads}, so a test can prove a refused request never reached storage
 * at all — "returned an error" and "returned an error without looking" are
 * different guarantees, and only the second one is the point.
 */
export class InMemoryAuditEventReader implements AuditEventReader {
  private readonly entries: { organizationId: string; entry: AuditLogEntry }[] = [];
  readonly reads: AuditEventCriteria[] = [];

  seed(organizationId: string, ...entries: AuditLogEntry[]): void {
    for (const entry of entries) this.entries.push({ organizationId, entry });
  }

  query(criteria: AuditEventCriteria, page: AuditEventPage): Promise<readonly AuditLogEntry[]> {
    this.reads.push(criteria);
    return Promise.resolve(
      this.matching(criteria)
        .filter((entry) => entry.sequence > (page.afterSequence ?? 0))
        .slice(0, page.limit),
    );
  }

  async *stream(criteria: AuditEventCriteria): AsyncIterable<AuditLogEntry> {
    this.reads.push(criteria);
    for (const entry of this.matching(criteria)) {
      await Promise.resolve();
      yield entry;
    }
  }

  private matching(criteria: AuditEventCriteria): AuditLogEntry[] {
    return this.entries
      .filter(({ organizationId }) => organizationId === criteria.organizationId)
      .map(({ entry }) => entry)
      .filter(
        (entry) =>
          (criteria.actorId === undefined || entry.actorId === criteria.actorId) &&
          (criteria.subjectId === undefined || entry.subjectId === criteria.subjectId) &&
          (criteria.from === undefined || entry.occurredAt >= criteria.from) &&
          (criteria.to === undefined || entry.occurredAt <= criteria.to),
      )
      .sort((a, b) => a.sequence - b.sequence);
  }
}
