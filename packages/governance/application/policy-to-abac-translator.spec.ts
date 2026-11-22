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
});
