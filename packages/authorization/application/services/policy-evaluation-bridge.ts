import type { AuthorizationRequest } from "../../domain/attribute-context.js";
import { emptyAttributeContext } from "../../domain/attribute-context.js";
import { denyOverrides, deriveRuleOutcomes } from "../../domain/services/combining-algorithms.js";
import { AttributeContext } from "../../domain/value-objects/attribute-context.js";
import type { OrganizationPolicy, OrgPolicySource } from "../ports/org-policy-source.js";
import type { PolicyDecisionPoint, PolicyEvaluation } from "../ports/policy-decision-point.js";

export interface PolicyTranslator {
  translate(policy: OrganizationPolicy): {
    readonly policyId: string;
    readonly rules: Parameters<typeof deriveRuleOutcomes>[0];
  };
}

/** Evaluates the published governance policies for the request's organization. */
export class PolicyEvaluationBridge implements PolicyDecisionPoint {
  constructor(
    private readonly policies: OrgPolicySource,
    private readonly translator: PolicyTranslator,
  ) {}

  async evaluate(request: AuthorizationRequest): Promise<PolicyEvaluation> {
    const policies = await this.policies.findPublishedForOrganization(request.subject.tenantId);
    const context = enrichContext(request);
    const outcomes: Array<{ policyId: string; outcome: "PERMIT" | "DENY" | "NOT_APPLICABLE" }> = [];

    try {
      for (const policy of policies.filter(({ status }) => status === "published")) {
        // Defence in depth: the source is asked for this organization only, but
        // if it ever returned another tenant's policy, applying it would leak
        // one organization's rules into another's decisions. Fail closed.
        if (policy.organizationId !== request.subject.tenantId) {
          return {
            effect: "DENY",
            reason: "Policy belongs to another organization",
            matchedPolicyIds: [],
          };
        }
        const translated = this.translator.translate(policy);
        for (const outcome of deriveRuleOutcomes(translated.rules, context)) {
          outcomes.push({ policyId: translated.policyId, outcome });
        }
      }
    } catch {
      // A malformed or stale governance snapshot must never become a permit.
      return { effect: "DENY", reason: "Policy translation failed", matchedPolicyIds: [] };
    }

    const effect = denyOverrides(outcomes.map(({ outcome }) => outcome));
    return {
      effect,
      reason:
        effect === "NOT_APPLICABLE"
          ? "No applicable policy"
          : `ABAC policy ${effect.toLowerCase()}`,
      matchedPolicyIds: [
        ...new Set(
          outcomes
            .filter(({ outcome }) => outcome !== "NOT_APPLICABLE")
            .map(({ policyId }) => policyId),
        ),
      ],
    };
  }
}

function enrichContext(request: AuthorizationRequest): AttributeContext {
  const context = request.context ?? emptyAttributeContext();
  return AttributeContext.create({
    subject: {
      ...context.subject,
      id: request.subject.subjectId,
      organizationId: request.subject.tenantId,
    },
    action: { ...context.action, name: request.action },
    resource: {
      ...context.resource,
      type: request.resource.resourceType,
      id: request.resource.resourceId,
    },
    environment: context.environment as never,
  });
}
