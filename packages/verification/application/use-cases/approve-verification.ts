import { NotFoundError, Result, ValidationError } from "@verixa/shared-kernel";

import type { ReviewerId } from "../../domain/entities/review-assignment.js";
import type {
  VerificationRequest,
  VerificationRequestId,
} from "../../domain/entities/verification-request.js";
import type { InvalidStatusTransitionError } from "../../domain/errors/invalid-status-transition.js";
import type { ReviewDecisionNotPermittedError } from "../../domain/errors/review-decision-not-permitted.js";
import type { VerificationRequestRepository } from "../ports/verification-request-repository.js";

export interface ApproveVerificationCommand {
  readonly requestId: VerificationRequestId;
  readonly reviewerId: ReviewerId;
  /** Why the request was approved. Mandatory and non-empty. */
  readonly note: string;
  /** Injected clock for tests; defaults to `new Date()`. */
  readonly now?: Date;
}

export type ApproveVerificationError =
  ValidationError | NotFoundError | InvalidStatusTransitionError | ReviewDecisionNotPermittedError;

/**
 * Records a reviewer's approval. A rationale note is mandatory so the decision can be defended to
 * an auditor, a regulator or the subject later; the requirement is on this action, not the
 * aggregate.
 *
 * The aggregate checks the claim and the transition from its current state, so of two reviewers
 * racing on one case, the second fails the claim check instead of deciding twice.
 */
export class ApproveVerification {
  constructor(private readonly requests: VerificationRequestRepository) {}

  async execute(
    command: ApproveVerificationCommand,
  ): Promise<Result<VerificationRequest, ApproveVerificationError>> {
    const note = command.note.trim();
    if (note.length === 0) {
      return Result.err(
        new ValidationError("A rationale note is required to approve a verification request.", {
          note: ["required"],
        }),
      );
    }

    const request = await this.requests.findById(command.requestId);
    if (request === undefined) {
      return Result.err(
        new NotFoundError(`Verification request ${command.requestId} was not found.`),
      );
    }

    const approved = request.approve({
      reviewerId: command.reviewerId,
      note,
      now: command.now ?? new Date(),
    });
    if (Result.isErr(approved)) {
      return approved;
    }

    await this.requests.save(approved.value);

    // The returned aggregate carries the `VerificationDecided` event; pulling
    // and publishing it is the composition root's job once a publisher exists
    // (see `docs/guides/domain-events.md`), exactly as with `RegisterUser`.
    return Result.ok(approved.value);
  }
}
