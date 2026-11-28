import type { AttributeContext } from "../../domain/attribute-context.js";
import type { PolicyEffect } from "../../domain/authorization-decision.js";

/**
 * The evaluation engine as the policy simulator needs it. Unlike {@link PolicyDecisionPoint} it
 * reports per-rule detail and the combining step, so an author can see why a dry run produced its
 * result. Inputs are fixtures only: no database, session or HTTP request.
 */

/**
 * The policy under test: a `draft` is evaluated from text and never persisted; a `stored` reference
 * evaluates the policy production would use.
 */
export type PolicySource =
  | { readonly kind: "stored"; readonly ref: string }
  | { readonly kind: "draft"; readonly label: string; readonly dsl: string };

/** One rule's contribution to a run. */
export interface SimulatedRuleOutcome {
  readonly ruleId: string;
  /** What this rule alone concluded. `NOT_APPLICABLE` means its condition did not match. */
  readonly effect: PolicyEffect;
  /**
   * Whether this rule's effect is the one the combining step reported. A `PERMIT`
   * rule that was overridden by a `DENY` is not decisive, and saying so is what
   * turns "expected PERMIT, got DENY" into an explanation.
   */
  readonly decisive: boolean;
}

/** Everything one fixture's evaluation produced. */
export interface PolicySimulationRun {
  /** Human-readable identity of the policy that ran — a stored ref, or a draft's label. */
  readonly policyLabel: string;
  readonly combinedEffect: PolicyEffect;
  /** Named so a report can say which strategy produced the effect. */
  readonly combiningAlgorithm: string;
  readonly matchedPolicyIds: readonly string[];
  readonly rules: readonly SimulatedRuleOutcome[];
}

/** Port implemented by the policy engine that compiles and evaluates the DSL. */
export interface PolicySimulationEngine {
  /**
   * Evaluates `policy` against `context` without persisting anything.
   *
   * - Read-only: never publishes, versions or caches the policy.
   * - Reports every applicable rule, with `NOT_APPLICABLE` for rules that did not match.
   * - Names the combining algorithm that produced `combinedEffect`.
   * - Missing attributes are not errors; a rule with missing operands does not match.
   * - An unreachable policy store throws; it is an infrastructure failure, not a result.
   */
  simulate(policy: PolicySource, context: AttributeContext): Promise<PolicySimulationRun>;
}
