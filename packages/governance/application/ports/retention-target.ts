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
 * What one bounded context exposes so governance can enforce retention on its
 * data without reaching into that context's tables. Each context implements
 * this itself, and governance never imports a context's repository.
 *
 * Contract every implementation must keep (a second implementation is only
 * interchangeable if it keeps all of these):
 *
 * - **Scoped.** Both methods act only on records of `organizationId`. A record
 *   of another organization is never returned and never changed.
 * - **Honest cutoff.** `findExpired` returns only records whose own end of life
 *   is at or before `cutoff`. A live record (an active session, a case still
 *   under review) is never expired, however old.
 * - **No repeats.** `findExpired` must not return a record that `apply` has
 *   already handled with `query.action`. Otherwise anonymizing or archiving,
 *   which leave the record in place, would be rediscovered on every run.
 * - **Bounded.** `findExpired` returns at most `limit` records, so a first run
 *   over years of data is processed in batches.
 * - **Idempotent.** `apply` repeated for the same record and action is safe: the
 *   second call returns `already_applied` and changes nothing. This is what
 *   makes re-running the job after a crash safe, because the job may have
 *   applied an action and died before recording it.
 * - **Honest about support.** `apply` throws for an action not in
 *   `supportedActions` rather than silently doing something else.
 * - **Failure is an exception.** A failed change throws; it never returns
 *   `applied`.
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
