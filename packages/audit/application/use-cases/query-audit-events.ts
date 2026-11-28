import { Result } from "@verixa/shared-kernel";

import type { AuditLogEntry } from "../../domain/entities/audit-log-entry.js";
import type { AuditReader } from "../../domain/policies/audit-access-policy.js";
import { type AuditReadError, authorizeAndRecordAuditRead } from "../audit-read-access.js";
import type { AuditEventReader } from "../ports/audit-event-reader.js";

import type { RecordAuditEvent } from "./record-audit-event.js";

/** The largest page a single query may return. */
export const MAX_AUDIT_QUERY_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;

export interface QueryAuditEventsCommand {
  /** The authenticated caller, built by the interface layer — see {@link AuditReader}. */
  readonly reader: AuditReader;
  /** Whose audit log to read. Must be the reader's own organization. */
  readonly organizationId: string;
  readonly actorId?: string | undefined;
  readonly subjectId?: string | undefined;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
  /** Keyset cursor: the last `sequence` of the previous page. */
  readonly afterSequence?: number | undefined;
  /** Clamped to `1..`{@link MAX_AUDIT_QUERY_PAGE_SIZE}. */
  readonly limit?: number | undefined;
}

/**
 * One page of the log and the cursor for the next. Keyset pagination keeps every page a cheap
 * indexed range scan; the trade-off is forward-only paging.
 */
export interface QueryAuditEventsResult {
  readonly entries: readonly AuditLogEntry[];
  /** The `sequence` to pass as the next `afterSequence`, or undefined at the end. */
  readonly nextCursor: number | undefined;
  readonly hasMore: boolean;
}

/**
 * Reads one page of an organization's audit log and records the read before returning entries.
 * Requires `audit:query` in that organization.
 *
 * Page size is capped so a large query cannot act as an export under the weaker `audit:query`
 * permission.
 */
export class QueryAuditEvents {
  constructor(
    private readonly events: AuditEventReader,
    private readonly recordAuditEvent: RecordAuditEvent,
  ) {}

  async execute(
    command: QueryAuditEventsCommand,
  ): Promise<Result<QueryAuditEventsResult, AuditReadError>> {
    const criteria = {
      organizationId: command.organizationId,
      actorId: command.actorId,
      subjectId: command.subjectId,
      from: command.from,
      to: command.to,
    };

    const access = await authorizeAndRecordAuditRead(
      this.recordAuditEvent,
      command.reader,
      "query",
      criteria,
    );
    if (Result.isErr(access)) return access;

    const limit = Math.min(
      Math.max(Math.trunc(command.limit ?? DEFAULT_PAGE_SIZE), 1),
      MAX_AUDIT_QUERY_PAGE_SIZE,
    );

    // One row beyond the page, so "is there another page?" is answered without
    // a second query and without reading rows that will not be returned.
    const page = await this.events.query(criteria, {
      afterSequence: command.afterSequence,
      limit: limit + 1,
    });

    const hasMore = page.length > limit;
    const entries = hasMore ? page.slice(0, limit) : page;

    return Result.ok({
      entries,
      hasMore,
      nextCursor: hasMore ? entries[entries.length - 1]?.sequence : undefined,
    });
  }
}
