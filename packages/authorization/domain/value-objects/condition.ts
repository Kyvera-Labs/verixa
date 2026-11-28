/**
 * A boolean expression a {@link Rule} evaluates: leaf comparisons combined with `AND`/`OR`/`NOT`,
 * since real conditions nest ("(owner OR admin) AND NOT locked"). Immutable plain data (a
 * discriminated union), which keeps structural equality simple (see {@link conditionsEqual}).
 */
export type Condition =
  AlwaysCondition | ComparisonCondition | AndCondition | OrCondition | NotCondition;

/**
 * Matches unconditionally. This is the "explicit always marker" a
 * {@link Rule} can use instead of a real comparison — see `rule.ts` for why
 * a rule needs one or the other, never neither.
 */
export interface AlwaysCondition {
  readonly kind: "always";
}

/**
 * The operators available to a leaf comparison.
 *
 * Deliberately minimal for now: this is the shape a comparison takes, not
 * its evaluation semantics (type coercion rules, regex matching, time
 * windows) — those belong to the operator library and the
 * evaluation engine, which the domain layer must not depend on.
 */
export type ComparisonOperator = "eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "in" | "contains";

/**
 * A literal a comparison's right-hand side may hold. Restricted to
 * JSON-serializable primitives and arrays of them, since a `Policy` must
 * remain serialization-agnostic (storable as JSON/DSL text without a custom
 * codec).
 */
export type ComparisonLiteral = string | number | boolean | readonly (string | number)[];

/**
 * A leaf comparison of a named attribute (a dotted path such as `"resource.ownerId"`) against a
 * literal using `operator`. The attribute is a path string so conditions stay serializable as DSL
 * text or JSON.
 */
export interface ComparisonCondition {
  readonly kind: "comparison";
  readonly attribute: string;
  readonly operator: ComparisonOperator;
  readonly value: ComparisonLiteral;
}

/** Matches when every operand matches. Empty `operands` would be vacuously true; forbidden by {@link Condition.and}. */
export interface AndCondition {
  readonly kind: "and";
  readonly operands: readonly Condition[];
}

/** Matches when at least one operand matches. Empty `operands` would be vacuously false; forbidden by {@link Condition.or}. */
export interface OrCondition {
  readonly kind: "or";
  readonly operands: readonly Condition[];
}

/** Matches when its single operand does not. */
export interface NotCondition {
  readonly kind: "not";
  readonly operand: Condition;
}

function always(): AlwaysCondition {
  return Object.freeze({ kind: "always" });
}

function comparison(
  attribute: string,
  operator: ComparisonOperator,
  value: ComparisonLiteral,
): ComparisonCondition {
  return Object.freeze({ kind: "comparison", attribute, operator, value });
}

/**
 * @throws {Error} if `operands` is empty. An empty conjunction has no
 * well-defined authorization meaning to fall back to (unlike, say, an empty
 * list summing to zero) — every construction site has enough information to
 * avoid this, so a thrown error at build time is preferable to a "matches
 * everything" node that only reveals itself as a bug during evaluation.
 */
function and(operands: readonly Condition[]): AndCondition {
  if (operands.length === 0) {
    throw new Error("Condition.and() requires at least one operand.");
  }
  return Object.freeze({ kind: "and", operands: Object.freeze([...operands]) });
}

/** @throws {Error} if `operands` is empty — see {@link and}. */
function or(operands: readonly Condition[]): OrCondition {
  if (operands.length === 0) {
    throw new Error("Condition.or() requires at least one operand.");
  }
  return Object.freeze({ kind: "or", operands: Object.freeze([...operands]) });
}

function not(operand: Condition): NotCondition {
  return Object.freeze({ kind: "not", operand });
}

/**
 * Structural equality: two trees are equal when they have the same shape and
 * values throughout, regardless of object identity. Recursive rather than a
 * generic deep-equal so it stays exact about what "equal" means for each
 * node kind (e.g. `and` operand *order* matters — `A AND B` and `B AND A`
 * are different trees here, since a general-purpose deep-equal would need
 * to be told that, and getting it wrong silently would be worse than the
 * duplication of writing it out).
 */
function conditionsEqual(a: Condition, b: Condition): boolean {
  if (a.kind !== b.kind) {
    return false;
  }

  switch (a.kind) {
    case "always":
      return true;
    case "comparison": {
      const other = b as ComparisonCondition;
      if (a.attribute !== other.attribute || a.operator !== other.operator) {
        return false;
      }
      if (Array.isArray(a.value) || Array.isArray(other.value)) {
        const aValues: readonly (string | number)[] = Array.isArray(a.value) ? a.value : [];
        const otherValues: readonly (string | number)[] = Array.isArray(other.value)
          ? other.value
          : [];
        return (
          Array.isArray(a.value) &&
          Array.isArray(other.value) &&
          aValues.length === otherValues.length &&
          aValues.every((item, index) => item === otherValues[index])
        );
      }
      return a.value === other.value;
    }
    case "not":
      return conditionsEqual(a.operand, (b as NotCondition).operand);
    case "and":
    case "or": {
      const otherOperands = (b as AndCondition | OrCondition).operands;
      return (
        a.operands.length === otherOperands.length &&
        a.operands.every((operand, index) => {
          const otherOperand = otherOperands[index];
          return otherOperand !== undefined && conditionsEqual(operand, otherOperand);
        })
      );
    }
  }
}

export const Condition = { always, comparison, and, or, not, equals: conditionsEqual };
