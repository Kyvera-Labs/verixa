/**
 * The outcome Phase 07's role/permission layer contributes for one
 * `(subject, action, resourceType)` check — the same three-state shape as
 * {@link import("../../domain/services/combining-algorithms.js").RuleOutcome},
 * for the same reason: a role check that simply has no opinion about this
 * action (`NOT_APPLICABLE`) must be distinguishable from one that actively
 * denies it, since {@link import("../services/authorization-service.js").AuthorizationService}
 * needs to fall through to ABAC evaluation only in the former case.
 */
export type RbacDecision = "PERMIT" | "DENY" | "NOT_APPLICABLE";

/**
 * Port `AuthorizationService` uses to consult role and permission grants (the RBAC half of
 * RBAC+ABAC). {@link NoRbacGrants} is used until a real implementation is wired in the composition
 * root.
 */
export interface RbacAuthorizationPort {
  checkGrant(params: {
    subjectId: string;
    action: string;
    resourceType: string;
  }): Promise<RbacDecision>;
}

/**
 * RBAC layer with no roles to consult. Returns no opinion for every request, which is accurate
 * while no roles are defined.
 */
export class NoRbacGrants implements RbacAuthorizationPort {
  checkGrant(): Promise<RbacDecision> {
    return Promise.resolve("NOT_APPLICABLE");
  }
}
