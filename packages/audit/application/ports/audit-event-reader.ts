import type { AuditLogEntry } from "../../domain/entities/audit-log-entry.js";

/**
 * What a read of the audit log is scoped to.
 *
 * `organizationId` is required, and it is set by the query/export use cases
 * from the *authorized* organization — never passed through from a caller.
 * An adapter therefore never sees an unscoped read, and "forgot to add the
 * tenant filter" is not a bug an implementation of this port can have.
 */
export interface AuditEventCriteria {
  readonly organizationId: string;
  readonly actorId?: string | undefined;
  readonly subjectId?: string | undefined;
  /** Inclusive lower bound on `occurredAt`. */
  readonly from?: Date | undefined;
  /** Inclusive upper bound on `occurredAt`. */
  readonly to?: Date | undefined;
}

/** A keyset page: entries with `sequence` greater than `afterSequence`. */
export interface AuditEventPage {
  readonly afterSequence?: number | undefined;
  readonly limit: number;
}

/**
 * Read side of the audit log for the query and export use cases. Separate from
 * `AuditLogRepository`, which must stay unscoped to append and verify the whole chain; this port is
 * always scoped to one organization.
 */
export interface AuditEventReader {
  /** Matching entries in ascending `sequence` order, at most `page.limit`. */
  query(criteria: AuditEventCriteria, page: AuditEventPage): Promise<readonly AuditLogEntry[]>;

  /**
   * Every matching entry in ascending `sequence` order, yielded incrementally
   * so an export of years of history never has to fit in memory at once.
   */
  stream(criteria: AuditEventCriteria): AsyncIterable<AuditLogEntry>;
}
