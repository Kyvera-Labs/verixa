import type { AuthorizationRequest } from "../../domain/attribute-context.js";

import type { PolicyEvaluation } from "./policy-decision-point.js";

/** Runtime seam through which authorization asks governance for an ABAC decision. */
export interface PolicyEvaluationPort {
  evaluate(request: AuthorizationRequest): Promise<PolicyEvaluation>;
}
