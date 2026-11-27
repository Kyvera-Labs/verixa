import { DEFAULT_CLAIM_TTL_MS, type ReviewerId } from "../../domain/entities/review-assignment.js";
import type {
  ClaimNextOutcome,
  VerificationRequestRepository,
} from "../ports/verification-request-repository.js";

export interface ClaimNextReviewCaseCommand {
  readonly reviewerId: ReviewerId;
  /** Injected clock for tests; defaults to `new Date()`. */
  readonly now?: Date;
}

/**
 * Queue policy, configurable per composition root rather than hard-coded, so
 * a deployment can run strict one-case-per-reviewer or allow a reviewer to
 * stack a few cases while they wait on slow evidence.
 */
export interface ClaimNextReviewCasePolicy {
  /** How long the resulting claim lives. Defaults to `ReviewAssignment`'s fifteen minutes. */
  readonly claimTtlMs?: number;
  /** When `true` (the default), a reviewer holding any active claim is refused another. */
  readonly oneAtATime?: boolean;
}

/**
 * Assigns the oldest claimable `in_review` request to the calling reviewer. Assignment happens
 * atomically in the repository, so two reviewers can never work the same case; this use case only
 * sets the claim policy (duration, one case at a time). An empty queue or an existing claim is
 * returned as an outcome, not an error.
 */
export class ClaimNextReviewCase {
  constructor(
    private readonly requests: VerificationRequestRepository,
    private readonly policy: ClaimNextReviewCasePolicy = {},
  ) {}

  async execute(command: ClaimNextReviewCaseCommand): Promise<ClaimNextOutcome> {
    return this.requests.claimNextInReview({
      reviewerId: command.reviewerId,
      now: command.now ?? new Date(),
      claimTtlMs: this.policy.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS,
      // One at a time by default. Fairness across reviewers is better served by
      // making someone finish a case than by letting the fastest clicker stack
      // the queue, and it bounds how much a vanished reviewer can hold.
      oneAtATime: this.policy.oneAtATime ?? true,
    });
  }
}
