import type { RetentionAction, RetentionResourceType } from "../../domain/retention-rule.js";

/** A record a target reports as past retention. */
export interface ExpiredResource {
  /** Stable id of the record inside its own context. Opaque to governance. */
  readonly resourceId: string;
}

/**
 * - `applied`: this call changed the record.
 * - `already_applied`: nothing was left to do (already deleted, anonymized or
 *   archived, or the record no longer exists). Not an error.
 */
export type ApplyOutcome = "applied" | "already_applied";

/**
 * What a bounded context exposes so governance can enforce retention without touching its tables.
 * Implementations must be:
 *
 * - **Scoped**: act only on records of `organizationId`.
 * - **Honest about the cutoff**: `findExpired` returns only records whose end of life is at or
 *   before `cutoff`, never live records such as an active session or a case under review.
 * - **Non-repeating**: `findExpired` never returns a record `apply` already handled with
 *   `query.action`, since anonymized or archived records stay in place.
 * - **Bounded**: `findExpired` returns at most `limit` records.
 * - **Idempotent**: repeating `apply` returns `already_applied` and changes nothing, so the job can
 *   safely rerun after a crash.
 * - **Explicit about support**: `apply` throws for an action outside `supportedActions`.
 * - **Throwing on failure**: a failed change throws and never returns `applied`.
 */
export interface RetentionTarget {
  readonly resourceType: RetentionResourceType;
  readonly supportedActions: readonly RetentionAction[];

  findExpired(query: {
    readonly organizationId: string;
    readonly action: RetentionAction;
    readonly cutoff: Date;
    readonly limit: number;
  }): Promise<readonly ExpiredResource[]>;

  apply(organizationId: string, resourceId: string, action: RetentionAction): Promise<ApplyOutcome>;
}
