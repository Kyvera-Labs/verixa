import { describe, expect, it } from "vitest";

import {
  PolicyToAbacRuleTranslator,
  PolicyTranslationError,
  type GovernancePolicy,
} from "./policy-to-abac-translator.js";

const policy = (overrides: Partial<GovernancePolicy> = {}): GovernancePolicy => ({
  id: "policy-1",
  organizationId: "org-1",
  status: "published",
  version: 1,
  ruleset: { rules: [{ effect: "PERMIT", condition: { kind: "always" } }] },
  ...overrides,
});

describe("PolicyToAbacRuleTranslator", () => {
  it("translates a published ruleset into ABAC rules", () => {
    const result = new PolicyToAbacRuleTranslator().translate(policy());
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]?.effect).toBe("PERMIT");
  });

  it("rejects drafts so they have no runtime effect", () => {
    expect(() => new PolicyToAbacRuleTranslator().translate(policy({ status: "draft" }))).toThrow(
      PolicyTranslationError,
    );
  });

  it("rejects malformed rulesets", () => {
    expect(() => new PolicyToAbacRuleTranslator().translate(policy({ ruleset: {} }))).toThrow(
      PolicyTranslationError,
    );
  });

  it("rejects a comparison with an operator the engine does not know", () => {
    // The engine has no default case: an unknown operator would evaluate as
    // not-applicable and silently disable a DENY rule, so it must not translate.
    const typo = policy({
      ruleset: {
        rules: [
          {
            effect: "DENY",
            condition: {
              kind: "comparison",
              attribute: "subject.role",
              operator: "equals",
              value: "x",
            },
          },
        ],
      },
    });
    expect(() => new PolicyToAbacRuleTranslator().translate(typo)).toThrow(PolicyTranslationError);
  });

  it("accepts every operator the engine supports", () => {
    for (const operator of ["eq", "neq", "lt", "lte", "gt", "gte", "in", "contains"]) {
      const p = policy({
        ruleset: {
          rules: [
            {
              effect: "DENY",
              condition: { kind: "comparison", attribute: "a", operator, value: 1 },
            },
          ],
        },
      });
      expect(() => new PolicyToAbacRuleTranslator().translate(p)).not.toThrow();
    }
  });

  const withCondition = (condition: unknown, effect: unknown = "DENY"): GovernancePolicy =>
    policy({ ruleset: { rules: [{ effect, condition }] } });
  const eq = { kind: "comparison", attribute: "a", operator: "eq", value: 1 };

  it("accepts nested not / and / or conditions", () => {
    const translator = new PolicyToAbacRuleTranslator();
    for (const condition of [
      { kind: "not", operand: eq },
      { kind: "and", operands: [eq, { kind: "always" }] },
      { kind: "or", operands: [eq, { kind: "not", operand: eq }] },
    ]) {
      expect(() => translator.translate(withCondition(condition))).not.toThrow();
    }
  });

  it.each([
    ["an unknown condition kind", { kind: "xor" }],
    ["a condition that is not an object", "always"],
    ["an array instead of a condition", [eq]],
    ["an empty and", { kind: "and", operands: [] }],
    ["an or with an invalid operand", { kind: "or", operands: [eq, { kind: "nope" }] }],
    ["a not with an invalid operand", { kind: "not", operand: null }],
    ["a comparison without a value", { kind: "comparison", attribute: "a", operator: "eq" }],
    [
      "a comparison with a non-string attribute",
      { kind: "comparison", attribute: 1, operator: "eq", value: 1 },
    ],
  ])("rejects %s", (_label, condition) => {
    expect(() => new PolicyToAbacRuleTranslator().translate(withCondition(condition))).toThrow(
      PolicyTranslationError,
    );
  });

  it("rejects an unknown effect and a rule that is not an object", () => {
    const translator = new PolicyToAbacRuleTranslator();
    expect(() => translator.translate(withCondition({ kind: "always" }, "ALLOW"))).toThrow(
      PolicyTranslationError,
    );
    expect(() => translator.translate(policy({ ruleset: { rules: ["DENY"] } }))).toThrow(
      PolicyTranslationError,
    );
    expect(() => translator.translate(policy({ ruleset: { rules: [] } }))).toThrow(
      PolicyTranslationError,
    );
  });

  it("carries the policy id, organization and version through", () => {
    const result = new PolicyToAbacRuleTranslator().translate(policy({ version: 4 }));
    expect(result).toMatchObject({ policyId: "policy-1", organizationId: "org-1", version: 4 });
  });
});
