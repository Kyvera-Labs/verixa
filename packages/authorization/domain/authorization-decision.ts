/**
 * The decision model returned by every authorization path, and the precedence contract that
 * combines them. Precedence is a named value and `deny-overrides` is the default (threats E-1 and
 * E-2 in docs/security/threat-model-abac.md); changing either is a security change.
 */

/** The two terminal outcomes a decision can have. There is no "abstain" at this layer. */
export type AuthorizationEffect = "PERMIT" | "DENY";

/**
 * What a policy evaluation can conclude. `NOT_APPLICABLE` is the third value
 * the composition service needs: "no policy targets this request" is a
 * different fact from "a policy denied it", and only the difference lets an
 * RBAC grant stand unrefined.
 */
export type PolicyEffect = "PERMIT" | "DENY" | "NOT_APPLICABLE";

/** Which layer produced the decision that is being returned. */
export type AuthorizationDecisionSource = "rbac" | "abac" | "composition" | "fail-closed";

/** A decision, with enough context to answer "why" without re-running the evaluation. */
export interface AuthorizationDecision {
  readonly effect: AuthorizationEffect;
  /** Layer that produced the returned effect. */
  readonly source: AuthorizationDecisionSource;
  /** Stable, human-readable explanation — safe to log, not safe to return to end users as-is. */
  readonly reason: string;
  /** Every policy that contributed to the decision, so an audit trail can reference them. */
  readonly matchedPolicyIds: readonly string[];
}

/**
 * How RBAC and ABAC decisions combine. The order is configuration, but {@link
 * assertAuthorizationPrecedenceIsSafe} rejects any configuration that breaks these rules:
 *
 * - An explicit ABAC `DENY` always overrides an RBAC `PERMIT`, so a policy can withhold what a role
 *   grants.
 * - An ABAC `PERMIT` never overrides an RBAC `DENY`, and `NOT_APPLICABLE` never becomes a permit.
 */
export interface AuthorizationPrecedence {
  /** When false, a role grant short-circuits the policy engine and an applicable `DENY` policy becomes unreachable. Mandated `true`. */
  readonly abacDenyOverridesRbacPermit: boolean;
  /** When true, an attribute policy can talk a revoked permission back into existence. Mandated `false`. */
  readonly abacPermitOverridesRbacDeny: boolean;
  /** Effect of "neither layer granted" — denial by absence of authority. Mandated `DENY`. */
  readonly defaultEffectWhenNoPolicyMatches: AuthorizationEffect;
}

/** The precedence order Verixa runs under, and the only one a boot will accept. */
export const AUTHORIZATION_PRECEDENCE: AuthorizationPrecedence = {
  abacDenyOverridesRbacPermit: true,
  abacPermitOverridesRbacDeny: false,
  defaultEffectWhenNoPolicyMatches: "DENY",
};

/** Raised when a configuration asks for a precedence order that is not safe to run. */
export class UnsafeAuthorizationPrecedenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeAuthorizationPrecedenceError";
  }
}

/**
 * Rejects a precedence order that weakens the composition contract. Called at service construction
 * so a bad configuration fails at boot. For example, an `rbac-first` mode that skips policies when
 * a role matches would let roles bypass every policy denial.
 */
export function assertAuthorizationPrecedenceIsSafe(
  precedence: AuthorizationPrecedence,
): AuthorizationPrecedence {
  if (!precedence.abacDenyOverridesRbacPermit) {
    throw new UnsafeAuthorizationPrecedenceError(
      "Unsafe authorization precedence: abacDenyOverridesRbacPermit must be true — a role grant may not outrank an explicit policy denial (threat E-1).",
    );
  }

  if (precedence.abacPermitOverridesRbacDeny) {
    throw new UnsafeAuthorizationPrecedenceError(
      "Unsafe authorization precedence: abacPermitOverridesRbacDeny must be false — an attribute policy may not overrule a role denial.",
    );
  }

  if (precedence.defaultEffectWhenNoPolicyMatches !== "DENY") {
    throw new UnsafeAuthorizationPrecedenceError(
      "Unsafe authorization precedence: defaultEffectWhenNoPolicyMatches must be DENY — permit-by-default grants every request no role and no policy mentions (threat E-2).",
    );
  }

  return precedence;
}

/**
 * Resolves the deployment's precedence order, defaulting to
 * {@link AUTHORIZATION_PRECEDENCE} and validating whatever it is given.
 */
export function resolveAuthorizationPrecedence(
  overrides?: Partial<AuthorizationPrecedence>,
): AuthorizationPrecedence {
  return assertAuthorizationPrecedenceIsSafe({ ...AUTHORIZATION_PRECEDENCE, ...overrides });
}

/**
 * The reason strings returned by the composition service and the simulator.
 * They are contract: tests assert on them and the audit trail records them, so
 * they change only deliberately.
 */
export const AUTHORIZATION_REASONS = {
  rbacGrant: "RBAC grant",
  rbacDeny: "RBAC denial",
  abacDeny: "ABAC policy denial",
  abacPermit: "ABAC policy permit",
  noApplicablePolicy: "No applicable policy",
  rbacUnavailable: "Role permission store unavailable",
  policyRepositoryUnavailable: "Policy repository unavailable",
  invalidRequest: "Invalid authorization request",
} as const;
