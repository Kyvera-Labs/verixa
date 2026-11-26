import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  collectWorkflowCheckContexts,
  validateBranchProtection,
} from "../../infra/ci/check-branch-protection.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

describe("branch protection policy (Issue #478)", () => {
  it("validates the checked-in .github/branch-protection.json against real workflows", () => {
    const rulesetPath = path.join(REPO_ROOT, ".github", "branch-protection.json");
    const workflowsDir = path.join(REPO_ROOT, ".github", "workflows");
    const ruleset: unknown = JSON.parse(fs.readFileSync(rulesetPath, "utf8"));
    const contexts = collectWorkflowCheckContexts(workflowsDir);

    const errors = validateBranchProtection(ruleset, contexts);
    expect(errors).toEqual([]);
  });

  it("rejects a ruleset that references a non-existent status check context", () => {
    const contexts = new Set(["ci", "commitlint"]);
    const ruleset = {
      enforcement: "active",
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } },
      rules: [
        { type: "deletion" },
        { type: "non_fast_forward" },
        {
          type: "pull_request",
          parameters: {
            required_approving_review_count: 1,
            dismiss_stale_reviews_on_push: true,
          },
        },
        {
          type: "required_status_checks",
          parameters: {
            strict_required_status_checks_policy: true,
            required_status_checks: [{ context: "ci" }, { context: "renamed-missing-job" }],
          },
        },
      ],
    };

    const errors = validateBranchProtection(ruleset, contexts);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("renamed-missing-job");
  });

  it("rejects a ruleset with fewer than 1 approving review or non-strict status checks", () => {
    const contexts = new Set(["ci"]);
    const ruleset = {
      enforcement: "active",
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } },
      rules: [
        { type: "deletion" },
        { type: "non_fast_forward" },
        {
          type: "pull_request",
          parameters: {
            required_approving_review_count: 0,
            dismiss_stale_reviews_on_push: false,
          },
        },
        {
          type: "required_status_checks",
          parameters: {
            strict_required_status_checks_policy: false,
            required_status_checks: [{ context: "ci" }],
          },
        },
      ],
    };

    const errors = validateBranchProtection(ruleset, contexts);
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
});
