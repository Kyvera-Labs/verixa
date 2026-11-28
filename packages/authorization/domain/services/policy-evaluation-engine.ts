import type { AttributeContext, AttributeValue } from "../value-objects/attribute-context.js";
import type { ComparisonCondition, Condition } from "../value-objects/condition.js";
import type { Rule } from "../value-objects/rule.js";

function isOrderable(value: AttributeValue): value is number | Date {
  return typeof value === "number" || value instanceof Date;
}

function orderableValueOf(value: number | Date): number {
  return value instanceof Date ? value.getTime() : value;
}

/**
 * Evaluates one leaf comparison. Types are never coerced: comparing a number to a string evaluates
 * to `false`, so a type mistake shows up as a non-matching rule.
 */
function evaluateComparison(condition: ComparisonCondition, context: AttributeContext): boolean {
  const actual = context.resolve(condition.attribute);
  if (actual === undefined) {
    return false;
  }

  switch (condition.operator) {
    case "eq":
      if (Array.isArray(actual) || Array.isArray(condition.value)) {
        return false;
      }
      if (actual instanceof Date) {
        return (
          typeof condition.value === "string" && actual.getTime() === Date.parse(condition.value)
        );
      }
      return actual === condition.value;
    case "neq":
      return !evaluateComparison({ ...condition, operator: "eq" }, context);
    case "lt":
    case "lte":
    case "gt":
    case "gte": {
      if (!isOrderable(actual) || typeof condition.value !== "number") {
        return false;
      }
      const actualValue = orderableValueOf(actual);
      switch (condition.operator) {
        case "lt":
          return actualValue < condition.value;
        case "lte":
          return actualValue <= condition.value;
        case "gt":
          return actualValue > condition.value;
        case "gte":
          return actualValue >= condition.value;
      }
      break;
    }
    case "in": {
      if (!Array.isArray(condition.value) || Array.isArray(actual) || actual instanceof Date) {
        return false;
      }
      return (condition.value as readonly (string | number)[]).includes(actual as string | number);
    }
    case "contains": {
      if (!Array.isArray(actual) || Array.isArray(condition.value)) {
        return false;
      }
      return (actual as readonly (string | number)[]).includes(condition.value as string | number);
    }
  }
}

/**
 * Evaluates a {@link Condition} tree against an {@link AttributeContext}. Pure, with no I/O.
 * `AND`/`OR` short-circuit, and a missing attribute evaluates to `false` rather than throwing.
 */
export function evaluateCondition(condition: Condition, context: AttributeContext): boolean {
  switch (condition.kind) {
    case "always":
      return true;
    case "comparison":
      return evaluateComparison(condition, context);
    case "and":
      return condition.operands.every((operand) => evaluateCondition(operand, context));
    case "or":
      return condition.operands.some((operand) => evaluateCondition(operand, context));
    case "not":
      return !evaluateCondition(condition.operand, context);
  }
}

/**
 * Evaluates whether `rule`'s condition matches `context`. Does not consult
 * `rule.effect` — deriving a `PERMIT`/`DENY`/`NOT_APPLICABLE` outcome from a
 * match/no-match result is `combining-algorithms.ts`'s job, kept
 * separate so this evaluator stays a pure boolean predicate.
 */
export function evaluateRule(rule: Rule, context: AttributeContext): boolean {
  return evaluateCondition(rule.condition, context);
}
