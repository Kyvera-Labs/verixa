import type { Result } from "@verixa/shared-kernel";

import type { AuditEvent, AuditEventId } from "../../domain/entities/audit-event.js";
import type { AuditAction } from "../../domain/value-objects/audit-action.js";

/**
 * Query filters for searching audit events.
 */
export interface AuditEventFilters {
  /** Filter by actor who initiated the actions */
  readonly actorId?: string;
  /** Filter by action type */
  readonly action?: AuditAction;
  /** Filter by resource type */
  readonly resourceType?: string;
  /** Filter by specific resource ID */
  readonly resourceId?: string;
  /** Filter by organization (required for tenant isolation) */
  readonly organizationId: string;
  /** Filter by timestamp range (inclusive) */
  readonly timestampFrom?: Date;
  readonly timestampTo?: Date;
}

/**
 * Pagination parameters for query results.
 */
export interface PaginationParams {
  /** Cursor for keyset pagination (opaque string from previous result) */
  readonly cursor?: string;
  /** Maximum number of results to return */
  readonly limit: number;
}

/**
 * Paginated query result.
 */
export interface PaginatedAuditEvents {
  /** The events matching the query */
  readonly events: readonly AuditEvent[];
  /** Cursor for fetching the next page, undefined if this is the last page */
  readonly nextCursor?: string;
  /** Total count of events matching the filter (optional, may be expensive to compute) */
  readonly totalCount?: number;
}

/**
 * Repository port for audit events.
 *
 * Append-only: there is no update or delete. Immutability is enforced by the domain model, by this
 * interface and by revoked UPDATE/DELETE grants in the database.
 *
 * `append` returns a Result so callers can log a failed write and carry on; blocking the operation
 * that caused the event is worse than a gap in the trail (see `RecordAuditEvent`).
 *
 * Every query requires `organizationId`, so a cross-tenant query cannot be written without working
 * around the types. Implementations must also enforce tenancy in the database. There is no
 * standalone count; `totalCount` is optional and may be omitted when it would be expensive.
 */
export interface AuditEventRepository {
  /**
   * Appends a new audit event to the log.
   *
   * This is the sole write operation. No update, delete, or bulk operations
   * exist — events are append-only.
   *
   * @param event - The event to append
   * @returns Success if the event was persisted, or an error describing why it failed
   */
  append(event: AuditEvent): Promise<Result<void, AppendAuditEventError>>;

  /**
   * Finds an audit event by ID within one organization.
   *
   * @param id - The event ID to look up
   * @param organizationId - The organization the event must belong to
   * @returns The event, or undefined if it does not exist in that organization
   */
  findById(id: AuditEventId, organizationId: string): Promise<AuditEvent | undefined>;

  /**
   * Queries audit events, newest first, with keyset pagination so pages stay stable under
   * concurrent inserts.
   *
   * @param filters - Query filters (organizationId is required)
   * @param pagination - Pagination parameters
   * @returns Paginated result set
   */
  query(filters: AuditEventFilters, pagination: PaginationParams): Promise<PaginatedAuditEvents>;

  /**
   * Returns an organization's events in insertion order, for chain verification and anchoring.
   *
   * @param organizationId - The organization whose events to retrieve
   * @param fromId - Start from this event ID (inclusive), or from the beginning if undefined
   * @param limit - Maximum number of events to return
   * @returns Events in sequence order
   */
  getSequenceRange(
    organizationId: string,
    fromId?: AuditEventId,
    limit?: number,
  ): Promise<readonly AuditEvent[]>;
}

/**
 * Errors that can occur when appending an audit event.
 */
export type AppendAuditEventError =
  | { readonly type: "database_unavailable"; readonly message: string }
  | { readonly type: "constraint_violation"; readonly message: string }
  | { readonly type: "unknown"; readonly message: string };

/**
 * Creates a database unavailable error.
 */
export function databaseUnavailableError(message: string): AppendAuditEventError {
  return { type: "database_unavailable", message };
}

/**
 * Creates a constraint violation error.
 */
export function constraintViolationError(message: string): AppendAuditEventError {
  return { type: "constraint_violation", message };
}

/**
 * Creates an unknown error.
 */
export function unknownAppendError(message: string): AppendAuditEventError {
  return { type: "unknown", message };
}
