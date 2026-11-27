import type { AuthorizationRequest } from "../../domain/attribute-context.js";
import type { PolicyEffect } from "../../domain/authorization-decision.js";

/**
 * The attribute-based half of an authorization question: Issue 148's combined
 * policy decision for one request.
 *
 * The port deliberately returns three values rather than a boolean. "No policy
 * targets this action" is not the same fact as "a policy denied it" — the
 * composition service needs the difference to decide whether an RBAC grant
 * stands, and the simulator needs it to explain a dry run.
 */

/** What the policy engine concluded, without losing which policies produced it. */
export interface PolicyEvaluation {
  readonly effect: PolicyEffect;
  /** Stable explanation, for logs, the audit trail, and dry-run reports. */
  readonly reason: string;
  /** Policies that matched the request and contributed to the effect. */
  readonly matchedPolicyIds: readonly string[];
}

/** Port implemented by the policy engine that compiles and evaluates the DSL. */
export interface PolicyDecisionPoint {
  /**
   * Evaluates every applicable policy for the request and returns the combined effect.
   *
   * - The combining strategy is always `deny-overrides`: one explicit `DENY` outranks any number of
   *   `PERMIT`s.
   * - `NOT_APPLICABLE` means no policy targets the request, never that evaluation failed.
   * - A condition with unresolved attributes evaluates to false; it does not throw.
   * - Only an unreachable policy store throws, and callers turn that into an explicit `DENY`.
   */
  evaluate(request: AuthorizationRequest): Promise<PolicyEvaluation>;
}
