import { BaseDomainEvent } from "@verixa/shared-kernel";

import type { ReviewerId } from "../entities/review-assignment.js";
import type {
  VerificationOrganizationId,
  VerificationRequestId,
  VerificationSubjectId,
} from "../entities/verification-request.js";
import type { VerificationTypeValue } from "../value-objects/verification-type.js";

/** The two terminal outcomes of a review. `needs_more_info` is not a decision — it re-opens the request. */
export type VerificationDecisionValue = "approved" | "rejected";

export interface VerificationDecidedParams {
  readonly requestId: VerificationRequestId;
  readonly subjectUserId: VerificationSubjectId;
  readonly organizationId: VerificationOrganizationId;
  readonly verificationType: VerificationTypeValue;
  readonly decision: VerificationDecisionValue;
  readonly decidedBy: ReviewerId;
  readonly decidedAt: Date;
  readonly note: string;
}

/**
 * A reviewer reached a terminal decision. The event carries the decision, reviewer and `note`
 * rather than just the request ID, so the audit trail records what happened at that moment even if
 * it is processed later, after the request has changed.
 */
export class VerificationDecided extends BaseDomainEvent {
  readonly eventName = "verification.request.decided";
  readonly subjectUserId: VerificationSubjectId;
  readonly organizationId: VerificationOrganizationId;
  readonly verificationType: VerificationTypeValue;
  readonly decision: VerificationDecisionValue;
  readonly decidedBy: ReviewerId;
  readonly decidedAt: Date;
  readonly note: string;

  constructor(params: VerificationDecidedParams) {
    super(params.requestId);
    this.subjectUserId = params.subjectUserId;
    this.organizationId = params.organizationId;
    this.verificationType = params.verificationType;
    this.decision = params.decision;
    this.decidedBy = params.decidedBy;
    this.decidedAt = params.decidedAt;
    this.note = params.note;
  }
}
