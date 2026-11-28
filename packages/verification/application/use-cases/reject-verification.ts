import { NotFoundError, Result, ValidationError } from "@verixa/shared-kernel";

import type { ReviewerId } from "../../domain/entities/review-assignment.js";
import type {
  VerificationRequest,
  VerificationRequestId,
} from "../../domain/entities/verification-request.js";
import type { InvalidStatusTransitionError } from "../../domain/errors/invalid-status-transition.js";
import type { ReviewDecisionNotPermittedError } from "../../domain/errors/review-decision-not-permitted.js";
import type { VerificationRequestRepository } from "../ports/verification-request-repository.js";

export interface RejectVerificationCommand {
  readonly requestId: VerificationRequestId;
  readonly reviewerId: ReviewerId;
  /** Why the request was rejected. Mandatory and non-empty. */
  readonly note: string;
  /** Injected clock for tests; defaults to `new Date()`. */
  readonly now?: Date;
}

export type RejectVerificationError =
  ValidationError | NotFoundError | InvalidStatusTransitionError | ReviewDecisionNotPermittedError;

/**
 * Records a reviewer's rejection, with a mandatory rationale, since a denial is the decision most
 * likely to be challenged. Kept separate from {@link ApproveVerification} despite the similarity,
 * so the two can evolve independently.
 */
export class RejectVerification {
  constructor(private readonly requests: VerificationRequestRepository) {}

  async execute(
    command: RejectVerificationCommand,
  ): Promise<Result<VerificationRequest, RejectVerificationError>> {
    const note = command.note.trim();
    if (note.length === 0) {
      return Result.err(
        new ValidationError("A rationale note is required to reject a verification request.", {
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

    const rejected = request.reject({
      reviewerId: command.reviewerId,
      note,
      now: command.now ?? new Date(),
    });
    if (Result.isErr(rejected)) {
      return rejected;
    }

    await this.requests.save(rejected.value);
    return Result.ok(rejected.value);
  }
}
