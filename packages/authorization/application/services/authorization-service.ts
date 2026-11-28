import {
  emptyAttributeContext,
  type AuthorizationRequest,
} from "../../domain/attribute-context.js";
import {
  AUTHORIZATION_REASONS,
  resolveAuthorizationPrecedence,
  type AuthorizationDecision,
  type AuthorizationDecisionSource,
  type AuthorizationPrecedence,
} from "../../domain/authorization-decision.js";
import type { PolicyDecisionPoint } from "../ports/policy-decision-point.js";
import type { RoleDecision, RolePermissionGate } from "../ports/role-permission-gate.js";

/**
 * Combines the RBAC check with the ABAC policy engine. RBAC runs first because it is one indexed
 * lookup, but a role grant does not skip policy evaluation, so a policy can still deny.
 *
 * | RBAC | ABAC | Result |
 * | --- | --- | --- |
 * | `deny` | not consulted | `DENY` |
 * | `grant` | `deny` | `DENY` |
 * | `grant` | `permit` / `NOT_APPLICABLE` | `PERMIT` |
 * | `no-match` | `permit` | `PERMIT` |
 * | `no-match` | `deny` | `DENY` |
 * | `no-match` | `NOT_APPLICABLE` | `DENY` (default deny) |
 *
 * Every failure, including an unreachable store or a malformed request, returns `DENY`; nothing
 * permits because something was unavailable. An unsafe precedence configuration throws at
 * construction.
 */
export class AuthorizationService {
  private readonly precedence: AuthorizationPrecedence;

  constructor(
    private readonly rolePermissionGate: RolePermissionGate,
    private readonly policyDecisionPoint: PolicyDecisionPoint,
    precedence?: Partial<AuthorizationPrecedence>,
  ) {
    this.precedence = resolveAuthorizationPrecedence(precedence);
  }

  /** The resolved precedence order, for composition-root logging and tests. */
  get precedenceOrder(): AuthorizationPrecedence {
    return this.precedence;
  }

  /**
   * Renders the authorization decision for one request.
   *
   * @param request who is doing what, to which resource, with which attributes
   */
  async authorize(request: AuthorizationRequest): Promise<AuthorizationDecision> {
    const malformed = malformedRequestReason(request);
    if (malformed !== undefined) {
      return deny("fail-closed", AUTHORIZATION_REASONS.invalidRequest, malformed);
    }

    let roleDecision: RoleDecision;
    try {
      roleDecision = await this.rolePermissionGate.check({
        subject: request.subject,
        action: request.action,
        resource: request.resource,
      });
    } catch {
      return deny("fail-closed", AUTHORIZATION_REASONS.rbacUnavailable);
    }

    // A role denial is final under both strategies: role denials are the floor
    // of the model, and no attribute condition is allowed to talk a revoked
    // permission back into existence.
    if (roleDecision.kind === "deny") {
      return deny("rbac", AUTHORIZATION_REASONS.rbacDeny);
    }

    const grantedByRole = roleDecision.kind === "grant";

    const evaluatedRequest: AuthorizationRequest = {
      subject: request.subject,
      action: request.action,
      resource: request.resource,
      context: request.context ?? emptyAttributeContext(),
    };

    let evaluation;
    try {
      evaluation = await this.policyDecisionPoint.evaluate(evaluatedRequest);
    } catch {
      return deny("fail-closed", AUTHORIZATION_REASONS.policyRepositoryUnavailable);
    }

    // A policy that produced an effect is what makes this a composed decision;
    // an RBAC-only outcome keeps the RBAC behaviour and its `rbac` source.
    const source: AuthorizationDecisionSource = grantedByRole ? "composition" : "abac";

    if (evaluation.effect === "DENY") {
      return {
        effect: "DENY",
        source,
        reason: AUTHORIZATION_REASONS.abacDeny,
        matchedPolicyIds: evaluation.matchedPolicyIds,
      };
    }

    if (evaluation.effect === "PERMIT") {
      return {
        effect: "PERMIT",
        source,
        reason: grantedByRole ? AUTHORIZATION_REASONS.rbacGrant : AUTHORIZATION_REASONS.abacPermit,
        matchedPolicyIds: evaluation.matchedPolicyIds,
      };
    }

    // No policy targets this request. A role grant still stands — that is Phase
    // 07 behaviour, unchanged and unrefined — while an ungranted request keeps
    // the default effect rather than being upgraded by the absence of a policy.
    if (grantedByRole) {
      return {
        effect: "PERMIT",
        source: "rbac",
        reason: AUTHORIZATION_REASONS.rbacGrant,
        matchedPolicyIds: [],
      };
    }

    return {
      effect: this.precedence.defaultEffectWhenNoPolicyMatches,
      source: "composition",
      reason: AUTHORIZATION_REASONS.noApplicablePolicy,
      matchedPolicyIds: [],
    };
  }
}

/** Builds a denial with no contributing policies. */
function deny(
  source: AuthorizationDecisionSource,
  reason: string,
  detail?: string,
): AuthorizationDecision {
  return {
    effect: "DENY",
    source,
    reason: detail === undefined ? reason : `${reason}: ${detail}`,
    matchedPolicyIds: [],
  };
}

/**
 * Rejects structurally unusable requests before any store or engine is touched.
 *
 * An empty `action` or `resourceType` is not a harmless edge case: a wildcard or
 * prefix rule in the policy set can match the empty string, and a role store
 * keyed on `(resourceType, action)` may answer with a bucket that no real
 * resource shares. Returning `DENY` here keeps those values out of both layers.
 */
function malformedRequestReason(request: AuthorizationRequest): string | undefined {
  if (request.subject.subjectId.trim() === "") return "subjectId is empty";
  if (request.subject.tenantId.trim() === "") return "tenantId is empty";
  if (request.action.trim() === "") return "action is empty";
  if (request.resource.resourceType.trim() === "") return "resourceType is empty";
  return undefined;
}
