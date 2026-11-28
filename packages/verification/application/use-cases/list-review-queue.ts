import { Result, ValidationError, ValidationErrorAggregator } from "@verixa/shared-kernel";

import type { ReviewerId } from "../../domain/entities/review-assignment.js";
import type {
  VerificationOrganizationId,
  VerificationRequest,
  VerificationRequestId,
  VerificationSubjectId,
} from "../../domain/entities/verification-request.js";
import type { VerificationStatusValue } from "../../domain/value-objects/verification-status.js";
import type { VerificationTypeValue } from "../../domain/value-objects/verification-type.js";
import type {
  QueueAssignmentFilter,
  VerificationRequestRepository,
} from "../ports/verification-request-repository.js";

/** Rows per page when the caller does not ask for a size. */
export const DEFAULT_QUEUE_PAGE_SIZE = 25;

/**
 * The largest page a caller may ask for.
 *
 * A ceiling rather than an unbounded `limit` because the page size is the
 * caller's to choose only within what the store can serve in one query; a
 * `limit: 100000` is not a page, it is a full table read wearing a page's
 * clothes, and it would arrive as one large response the UI cannot render.
 */
export const MAX_QUEUE_PAGE_SIZE = 100;

/**
 * Statuses a queue page may contain: `submitted` (awaiting the automated check) and `in_review`
 * (awaiting a reviewer), the only states a reviewer can act on.
 */
const REVIEWABLE_STATUSES: readonly VerificationStatusValue[] = ["submitted", "in_review"];

export interface ListReviewQueueQuery {
  /**
   * Narrows the page to one reviewable status. Omitted means both of
   * `REVIEWABLE_STATUSES`.
   *
   * A non-reviewable status is rejected rather than answered with an empty
   * page: "the queue is empty" and "you asked the queue for decided requests"
   * are different answers to different questions, and only one of them is
   * something the caller can act on.
   */
  readonly status?: VerificationStatusValue | undefined;
  readonly verificationType?: VerificationTypeValue | undefined;
  /** Defaults to `"any"` — claimed and unclaimed requests together. */
  readonly assignment?: QueueAssignmentFilter | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
  /** Injected clock for tests; defaults to `new Date()`. Used to tell a live claim from a lapsed one. */
  readonly now?: Date | undefined;
}

/**
 * The live claim on a queue row, if there is one.
 *
 * Absent — not `null` — when the request is unclaimed *or* its lease has
 * lapsed, because a reviewer looking for the next case cannot act differently
 * on those two situations.
 */
export interface ReviewQueueClaim {
  readonly reviewerId: ReviewerId;
  readonly claimedAt: Date;
  readonly expiresAt: Date;
}

/**
 * One row of the reviewer queue: enough to list and choose a case, and nothing more. Evidence,
 * storage references and signed URLs are deliberately absent; they belong on the per-request detail
 * route.
 */
export interface ReviewQueueItem {
  readonly requestId: VerificationRequestId;
  readonly subjectUserId: VerificationSubjectId;
  readonly organizationId: VerificationOrganizationId;
  readonly verificationType: VerificationTypeValue;
  readonly status: VerificationStatusValue;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly claim: ReviewQueueClaim | undefined;
}

/** One page of the queue, plus what the caller needs to ask for the next one. */
export interface ReviewQueuePage {
  readonly items: readonly ReviewQueueItem[];
  readonly limit: number;
  readonly offset: number;
  /**
   * Whether another row exists after this page, found by fetching one extra row rather than running
   * a separate `COUNT(*)` that could disagree with the page.
   */
  readonly hasMore: boolean;
}

/**
 * Lists reviewable work, oldest first, filtered and paginated.
 *
 * Returns a projection, not aggregates, so evidence and decision notes are structurally absent from
 * the response. Filtering, `limit` and `offset` are applied by the store; filtering after fetching
 * would return short pages and skip rows. Pagination relies on the port's oldest-first ordering.
 */
export class ListReviewQueue {
  constructor(private readonly requests: VerificationRequestRepository) {}

  async execute(
    query: ListReviewQueueQuery = {},
  ): Promise<Result<ReviewQueuePage, ValidationError>> {
    const now = query.now ?? new Date();
    const errors = new ValidationErrorAggregator();

    const statuses = resolveStatuses(query.status, errors);

    const limit = query.limit ?? DEFAULT_QUEUE_PAGE_SIZE;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_QUEUE_PAGE_SIZE) {
      errors.merge({
        limit: [`must be an integer between 1 and ${MAX_QUEUE_PAGE_SIZE}`],
      });
    }

    const offset = query.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0) {
      errors.merge({ offset: ["must be a non-negative integer"] });
    }

    if (errors.hasErrors()) {
      return Result.err(errors.toError("The review queue query is invalid."));
    }

    // One row beyond the page, so `hasMore` costs a row rather than a count.
    const rows = await this.requests.findQueueCandidates({
      statuses,
      verificationType: query.verificationType,
      assignment: query.assignment,
      now,
      limit: limit + 1,
      offset,
    });

    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map((request) =>
      toQueueItem(request, now),
    );

    return Result.ok({ items, limit, offset, hasMore });
  }
}

/**
 * The statuses this query lists, recording a field error instead when the
 * caller asked for a status the queue does not list.
 */
function resolveStatuses(
  status: VerificationStatusValue | undefined,
  errors: ValidationErrorAggregator,
): readonly VerificationStatusValue[] | undefined {
  if (status === undefined) {
    return REVIEWABLE_STATUSES;
  }
  if (!REVIEWABLE_STATUSES.includes(status)) {
    errors.merge({ status: ["not_reviewable"] });
    return undefined;
  }
  return [status];
}

/**
 * Projects a request onto a queue row, dropping a claim that has lapsed.
 *
 * `assignment: "any"` lists requests whose claim has expired on purpose — they
 * are back in the queue and a reviewer should see them. But the expired lease
 * is not an assignment, and reporting it would tell the UI a case is taken when
 * it is free to claim. The row reports the claim only while it is live at
 * `now`, which is the same question `VerificationRequest.isClaimableAt` asks.
 */
function toQueueItem(request: VerificationRequest, now: Date): ReviewQueueItem {
  const claim = request.assignment;

  return {
    requestId: request.id,
    subjectUserId: request.subjectUserId,
    organizationId: request.organizationId,
    verificationType: request.type.value,
    status: request.status.value,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    claim:
      claim === undefined || !claim.isActiveAt(now)
        ? undefined
        : {
            reviewerId: claim.reviewerId,
            claimedAt: claim.assignedAt,
            expiresAt: claim.claimExpiresAt,
          },
  };
}
