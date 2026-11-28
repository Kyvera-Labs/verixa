import { DomainError } from "@verixa/shared-kernel";

import type { VerificationRequestId } from "../entities/verification-request.js";

/**
 * A reviewer tried to decide a request they do not currently hold a claim on. Maps to 403, distinct
 * from `InvalidStatusTransitionError`: a queue can retry around ownership, but not around a final
 * decision. Role authorization is checked separately, before the use case.
 */
export class ReviewDecisionNotPermittedError extends DomainError {
  readonly code = "REVIEW_DECISION_NOT_PERMITTED";
  readonly httpStatusHint = 403;
  readonly requestId: VerificationRequestId;

  constructor(requestId: VerificationRequestId) {
    super(
      `Reviewer does not hold an active claim on verification request ${requestId}, so cannot decide it.`,
    );
    this.requestId = requestId;
  }

  override toJSON(): ReturnType<DomainError["toJSON"]> & { requestId: string } {
    return { ...super.toJSON(), requestId: this.requestId };
  }
}
