import type { Condition } from "../value-objects/condition.js";
import type { Effect } from "../value-objects/decision.js";

/**
 * A single policy rule: if `condition` holds, apply `effect`. Plain data with no behaviour, so the
 * evaluation engine and the linter share one interpretation without depending on each other.
 */
export interface Rule {
  readonly id: string;
  readonly effect: Effect;
  readonly condition: Condition;
}

/** An ordered set of rules combined by a single {@link CombiningAlgorithm}. */
export interface PolicySet {
  readonly id: string;
  readonly rules: readonly Rule[];
}
