import type { Condition, Effect, Rule } from "@verixa/authorization";
import { Rule as AbacRule } from "@verixa/authorization";

export interface GovernancePolicy {
  readonly id: string;
  readonly organizationId: string;
  readonly status: "draft" | "published" | "archived";
  readonly version: number;
  readonly ruleset: Readonly<Record<string, unknown>>;
}

export class PolicyTranslationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyTranslationError";
  }
}

export interface TranslatedPolicy {
  readonly policyId: string;
  readonly organizationId: string;
  readonly version: number;
  readonly rules: readonly Rule[];
}

/** Converts a published governance snapshot into the ABAC engine's rule shape. */
export class PolicyToAbacRuleTranslator {
  translate(policy: GovernancePolicy): TranslatedPolicy {
    if (policy.status !== "published")
      throw new PolicyTranslationError(`Policy ${policy.id} is not published.`);
    const rawRules = policy.ruleset.rules;
    if (!Array.isArray(rawRules) || rawRules.length === 0) {
      throw new PolicyTranslationError(`Policy ${policy.id} has no valid rules.`);
    }
    const rules = rawRules.map((rawRule, index) => {
      if (!isRecord(rawRule) || !isEffect(rawRule.effect) || !isCondition(rawRule.condition)) {
        throw new PolicyTranslationError(
          `Policy ${policy.id} contains an invalid rule at index ${index}.`,
        );
      }
      return AbacRule.create({ effect: rawRule.effect, condition: rawRule.condition });
    });
    return {
      policyId: policy.id,
      organizationId: policy.organizationId,
      version: policy.version,
      rules,
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isEffect(value: unknown): value is Effect {
  return value === "PERMIT" || value === "DENY";
}
function isCondition(value: unknown): value is Condition {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "always":
      return true;
    case "comparison":
      return (
        typeof value.attribute === "string" &&
        typeof value.operator === "string" &&
        value.value !== undefined
      );
    case "not":
      return isCondition(value.operand);
    case "and":
    case "or":
      return (
        Array.isArray(value.operands) &&
        value.operands.length > 0 &&
        value.operands.every(isCondition)
      );
    default:
      return false;
  }
}
