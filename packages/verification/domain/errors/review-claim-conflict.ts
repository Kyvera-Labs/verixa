import { DomainError } from "@verixa/shared-kernel";

import type { ReviewerId } from "../entities/review-assignment.js";
import type { VerificationRequestId } from "../entities/verification-request.js";

/**
 * A claim was attempted on a request another reviewer is actively working. A conflict rather than a
 * validation error; the existing claim is never overwritten.
 */
export class ReviewClaimConflictError extends DomainError {
  readonly code = "REVIEW_CLAIM_CONFLICT";
  readonly httpStatusHint = 409;
  readonly requestId: VerificationRequestId;
  readonly heldBy: ReviewerId;

  constructor(requestId: VerificationRequestId, heldBy: ReviewerId) {
    super(`Verification request ${requestId} is already claimed by reviewer ${heldBy}.`);
    this.requestId = requestId;
    this.heldBy = heldBy;
  }

  override toJSON(): ReturnType<DomainError["toJSON"]> & { requestId: string; heldBy: string } {
    return { ...super.toJSON(), requestId: this.requestId, heldBy: this.heldBy };
  }
}
