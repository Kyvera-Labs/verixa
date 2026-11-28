import type { ReviewerId } from "../../domain/entities/review-assignment.js";
import type {
  VerificationRequest,
  VerificationRequestId,
  VerificationSubjectId,
} from "../../domain/entities/verification-request.js";
import type { VerificationStatusValue } from "../../domain/value-objects/verification-status.js";
import type { VerificationTypeValue } from "../../domain/value-objects/verification-type.js";

/**
 * Which side of the queue's claim state a listing wants.
 *
 * Three values rather than a boolean, so "the UI has no filter selected" is
 * stated (`"any"`) rather than inferred from an absent field — inferred
 * absence is exactly how a filter ends up silently applied by one adapter and
 * silently ignored by another.
 */
export type QueueAssignmentFilter = "any" | "assigned" | "unassigned";

/**
 * Filters for the reviewer queue, applied by the store.
 *
 * `statuses` is a set because the default view spans `submitted` and `in_review`; one indexed query
 * keeps a stable global order, where merging two pages would not. `assignment` needs `now` because
 * claims are leases: a request whose claim expired is unassigned again even though its reviewer
 * column is still set.
 */
export interface QueueCandidateOptions {
  /** Statuses to include. Omitted means every status; a queue listing should pass only the statuses it considers reviewable. */
  readonly statuses?: readonly VerificationStatusValue[] | undefined;
  readonly verificationType?: VerificationTypeValue | undefined;
  /** Defaults to `"any"` — both claimed and unclaimed requests. */
  readonly assignment?: QueueAssignmentFilter | undefined;
  /** The instant `assignment` is evaluated at. Omitted means the adapter reads the clock itself, once. */
  readonly now?: Date | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

/**
 * What an atomic "claim the next case" attempt concluded.
 *
 * A discriminated union rather than `VerificationRequest | undefined` because
 * "there is nothing to claim" and "you already hold a case" need different
 * responses from the caller's side (idle, versus finish your current case
 * first), and collapsing them would force the use case to re-query to tell
 * them apart.
 */
export type ClaimNextOutcome =
  | { readonly kind: "claimed"; readonly request: VerificationRequest }
  | { readonly kind: "none" }
  | { readonly kind: "already_claiming" };

export interface ClaimNextInReviewParams {
  readonly reviewerId: ReviewerId;
  readonly now: Date;
  /** Lease length for the claim taken. See `ReviewAssignment`. */
  readonly claimTtlMs: number;
  /** When `true`, a reviewer holding any active claim is refused rather than given a second one. */
  readonly oneAtATime: boolean;
}

/**
 * Persistence port for `VerificationRequest`.
 *
 * - `findById`, `findBySubject` and `findQueueCandidates` return empty results when nothing
 *   matches.
 * - `save` is an idempotent upsert.
 * - `claimNextInReview` must be atomic: two concurrent calls never return the same request, and
 *   with `oneAtATime` a reviewer never holds two cases. The SQL adapter uses `SELECT ... FOR UPDATE
 *   SKIP LOCKED` (see docs/guides/use-cases.md).
 * - `findActiveClaimByReviewer` reports only claims still live at `now`.
 */
export interface VerificationRequestRepository {
  save(request: VerificationRequest): Promise<void>;

  findById(id: VerificationRequestId): Promise<VerificationRequest | undefined>;

  findBySubject(subjectUserId: VerificationSubjectId): Promise<VerificationRequest[]>;

  /**
   * Queue listing, oldest first. Detail beyond summary fields is fetched per
   * request.
   *
   * Filtering and pagination both belong here rather than to the calling use
   * case: a caller that fetched a page and then filtered it would return short
   * pages and skip rows that a later page should have contained.
   */
  findQueueCandidates(options?: QueueCandidateOptions): Promise<VerificationRequest[]>;

  /** The request `reviewerId` currently holds an unexpired claim on, if any. */
  findActiveClaimByReviewer(
    reviewerId: ReviewerId,
    now: Date,
  ): Promise<VerificationRequest | undefined>;

  /**
   * Atomically assigns the oldest claimable `in_review` request to
   * `reviewerId`, returning what happened. Never throws for a contested or
   * empty queue — those are the `already_claiming` and `none` outcomes.
   */
  claimNextInReview(params: ClaimNextInReviewParams): Promise<ClaimNextOutcome>;
}
