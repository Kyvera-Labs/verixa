import { describe, expect, it } from "vitest";

import { Rule } from "../../domain/value-objects/rule.js";
import type { OrganizationPolicy, OrgPolicySource } from "../ports/org-policy-source.js";

import { PolicyEvaluationBridge, type PolicyTranslator } from "./policy-evaluation-bridge.js";

const request = {
  subject: { subjectId: "user-1", tenantId: "org-1" },
  action: "read",
  resource: { resourceType: "document", resourceId: "doc-1" },
};
const source = (...policies: OrganizationPolicy[]): OrgPolicySource => ({
  findPublishedForOrganization: () => Promise.resolve(policies),
});
const translator: PolicyTranslator = {
  translate: (policy) => ({
    policyId: policy.id,
    rules: (
      policy.ruleset.rules as Array<{ effect: "PERMIT" | "DENY"; condition: { kind: "always" } }>
    ).map((rule) => Rule.create(rule)),
  }),
};
const policy = (overrides: Partial<OrganizationPolicy> = {}): OrganizationPolicy => ({
  id: "policy-1",
  organizationId: "org-1",
  status: "published",
  version: 1,
  ruleset: { rules: [{ effect: "PERMIT", condition: { kind: "always" } }] },
  ...overrides,
});

describe("PolicyEvaluationBridge", () => {
  it("makes a published policy change an authorization outcome", async () => {
    await expect(
      new PolicyEvaluationBridge(source(policy()), translator).evaluate(request),
    ).resolves.toMatchObject({ effect: "PERMIT", matchedPolicyIds: ["policy-1"] });
  });

  it("does not evaluate drafts", async () => {
    await expect(
      new PolicyEvaluationBridge(source(policy({ status: "draft" })), translator).evaluate(request),
    ).resolves.toMatchObject({ effect: "NOT_APPLICABLE", reason: "No applicable policy" });
  });

  it("fails closed when translation fails", async () => {
    await expect(
      new PolicyEvaluationBridge(source(policy({ ruleset: {} })), translator).evaluate(request),
    ).resolves.toMatchObject({ effect: "DENY" });
  });

  it("keeps an explicit deny ahead of a permit", async () => {
    const deny = policy({
      id: "deny",
      ruleset: { rules: [{ effect: "DENY", condition: { kind: "always" } }] },
    });
    await expect(
      new PolicyEvaluationBridge(source(policy(), deny), translator).evaluate(request),
    ).resolves.toMatchObject({ effect: "DENY", matchedPolicyIds: ["policy-1", "deny"] });
  });

  it("denies when the source returns a policy from another organization", async () => {
    const foreign = policy({ id: "foreign", organizationId: "org-2" });
    await expect(
      new PolicyEvaluationBridge(source(foreign), translator).evaluate(request),
    ).resolves.toMatchObject({ effect: "DENY", matchedPolicyIds: [] });
  });
});
