import { NotFoundError, Result, ValidationError } from "@verixa/shared-kernel";

import type { ReviewerId } from "../../domain/entities/review-assignment.js";
import type {
  VerificationRequest,
  VerificationRequestId,
} from "../../domain/entities/verification-request.js";
import type { InvalidStatusTransitionError } from "../../domain/errors/invalid-status-transition.js";
import type { ReviewDecisionNotPermittedError } from "../../domain/errors/review-decision-not-permitted.js";
import type { VerificationRequestRepository } from "../ports/verification-request-repository.js";

export interface RequestMoreInformationCommand {
  readonly requestId: VerificationRequestId;
  readonly reviewerId: ReviewerId;
  /** What is missing, visible to the subject. Mandatory and non-empty. */
  readonly note: string;
  /** Injected clock for tests; defaults to `new Date()`. */
  readonly now?: Date;
}

export type RequestMoreInformationError =
  ValidationError | NotFoundError | InvalidStatusTransitionError | ReviewDecisionNotPermittedError;

/**
 * Moves `in_review` to `needs_more_info` when the reviewer needs something specific from the
 * subject. The note is mandatory because it tells the subject what to do. The request is not
 * decided and can cycle through this state; the subject re-enters through
 * `VerificationRequest.reopenForEvidence`.
 */
export class RequestMoreInformation {
  constructor(private readonly requests: VerificationRequestRepository) {}

  async execute(
    command: RequestMoreInformationCommand,
  ): Promise<Result<VerificationRequest, RequestMoreInformationError>> {
    const note = command.note.trim();
    if (note.length === 0) {
      return Result.err(
        new ValidationError("A note describing the missing information is required.", {
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

    const updated = request.requestMoreInformation({
      reviewerId: command.reviewerId,
      note,
      now: command.now ?? new Date(),
    });
    if (Result.isErr(updated)) {
      return updated;
    }

    await this.requests.save(updated.value);
    return Result.ok(updated.value);
  }
}
