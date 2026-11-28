import { DomainError } from "@verixa/shared-kernel";

import type { VerificationStatusValue } from "../value-objects/verification-status.js";

/**
 * A status change the state machine does not allow, such as deciding an unclaimed request or
 * re-deciding a terminal one. Returned, not thrown, since races between reviewers are routine (see
 * docs/guides/error-handling.md). Maps to 409: the request was valid but the resource's state
 * refuses it.
 */
export class InvalidStatusTransitionError extends DomainError {
  readonly code = "INVALID_STATUS_TRANSITION";
  readonly httpStatusHint = 409;
  readonly from: VerificationStatusValue;
  readonly to: string;

  constructor(from: VerificationStatusValue, to: string) {
    super(`Cannot transition verification request from "${from}" to "${to}".`);
    this.from = from;
    this.to = to;
  }

  override toJSON(): ReturnType<DomainError["toJSON"]> & { from: string; to: string } {
    return { ...super.toJSON(), from: this.from, to: this.to };
  }
}
