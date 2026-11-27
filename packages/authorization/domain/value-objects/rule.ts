import { Condition } from "./condition.js";
import type { Effect } from "./effect.js";

interface RuleProps {
  readonly effect: Effect;
  readonly condition: Condition;
  readonly description: string | undefined;
}

/**
 * One `if <condition> then <effect>` clause in a {@link Policy}. An immutable value object created
 * only through {@link Rule.create}, which requires a condition. Rules are always loaded as part of
 * a `Policy`, so there is no `reconstitute`.
 */
export class Rule {
  readonly effect: Effect;
  readonly condition: Condition;
  readonly description: string | undefined;

  private constructor(props: RuleProps) {
    this.effect = props.effect;
    this.condition = props.condition;
    this.description = props.description;
  }

  /**
   * Every acceptance criterion for Issue 141 requires a rule to carry a
   * condition — "at least one condition or an explicit 'always' marker" — so
   * `condition` is required here, not optional. Pass
   * {@link Condition.always} for a rule meant to match unconditionally
   * (e.g. a catch-all `DENY` at the end of a policy); there is deliberately
   * no way to construct a `Rule` with `condition: undefined`, which is what
   * makes "always" an explicit choice rather than an accidental omission.
   */
  static create(params: {
    effect: Effect;
    condition: Condition;
    description?: string | undefined;
  }): Rule {
    return new Rule({
      effect: params.effect,
      condition: params.condition,
      description: params.description,
    });
  }

  /** Structural equality: same effect and same condition tree, regardless of `description`. */
  equals(other: Rule): boolean {
    return this.effect === other.effect && Condition.equals(this.condition, other.condition);
  }
}
