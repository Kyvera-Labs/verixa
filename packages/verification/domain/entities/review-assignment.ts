import { type Id, Result, ValidationError } from "@verixa/shared-kernel";

import type { VerificationRequestId } from "./verification-request.js";

export type ReviewerId = Id<"ReviewerId">;

/**
 * How long a reviewer's claim on a case lasts before it is automatically
 * released back to the queue.
 *
 * Fifteen minutes is a deliberately unglamorous number: long enough to read a
 * document and a selfie, short enough that a reviewer whose browser tab dies
 * mid-review does not hold a case hostage for the rest of the day. A lease
 * rather than a permanent lock — see the class comment.
 */
export const DEFAULT_CLAIM_TTL_MS = 15 * 60 * 1000;

interface ReviewAssignmentProps {
  readonly requestId: VerificationRequestId;
  readonly reviewerId: ReviewerId;
  readonly assignedAt: Date;
  readonly claimExpiresAt: Date;
}

/**
 * A reviewer's temporary claim on one request: an explicit, expiring lease. Explicit so the domain
 * can detect and refuse two reviewers on one case; expiring so an abandoned claim releases itself.
 * Immutable: a claim is replaced, never changed.
 */
export class ReviewAssignment {
  readonly requestId: VerificationRequestId;
  readonly reviewerId: ReviewerId;
  readonly assignedAt: Date;
  readonly claimExpiresAt: Date;

  private constructor(props: ReviewAssignmentProps) {
    this.requestId = props.requestId;
    this.reviewerId = props.reviewerId;
    this.assignedAt = props.assignedAt;
    this.claimExpiresAt = props.claimExpiresAt;
  }

  /**
   * Creates a claim of `requestId` by `reviewerId`, expiring `ttlMs` after
   * `assignedAt`.
   *
   * `assignedAt` is passed in rather than read from the clock so the claim and
   * the expiry derive from the same instant — computing them separately is
   * how a claim ends up a few milliseconds shorter or longer than intended in
   * a way no test can pin down.
   */
  static claim(params: {
    requestId: VerificationRequestId;
    reviewerId: ReviewerId;
    assignedAt: Date;
    ttlMs?: number | undefined;
  }): Result<ReviewAssignment, ValidationError> {
    const ttlMs = params.ttlMs ?? DEFAULT_CLAIM_TTL_MS;

    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      return Result.err(
        new ValidationError("Claim duration must be a positive number of milliseconds.", {
          claimTtlMs: ["invalid"],
        }),
      );
    }

    return Result.ok(
      new ReviewAssignment({
        requestId: params.requestId,
        reviewerId: params.reviewerId,
        assignedAt: params.assignedAt,
        claimExpiresAt: new Date(params.assignedAt.getTime() + ttlMs),
      }),
    );
  }

  /** Rebuilds from already-trusted data (e.g. a database row). */
  static reconstitute(props: ReviewAssignmentProps): ReviewAssignment {
    return new ReviewAssignment(props);
  }

  /** Whether the claim is still held at `now` — i.e. it has not expired. */
  isActiveAt(now: Date): boolean {
    return now.getTime() < this.claimExpiresAt.getTime();
  }

  /** Whether the claim has lapsed at `now` and the case is back in the queue. */
  isExpiredAt(now: Date): boolean {
    return !this.isActiveAt(now);
  }

  /** Whether `reviewerId` is the reviewer holding this claim. */
  isHeldBy(reviewerId: ReviewerId): boolean {
    return this.reviewerId === reviewerId;
  }
}
