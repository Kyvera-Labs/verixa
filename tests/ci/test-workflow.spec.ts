import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { REPO_ROOT } from "./helpers/ci-tooling.js";

describe("Test workflow & coverage reporting (#475)", () => {
  it("runs unit/coverage and Testcontainers integration suites in separate jobs", async () => {
    const workflowPath = path.resolve(REPO_ROOT, ".github/workflows/test.yml");
    const parsed = parseYaml(await fs.readFile(workflowPath, "utf-8")) as {
      jobs: Record<
        string,
        {
          env?: Record<string, string>;
          steps: Array<{ run?: string; uses?: string; if?: string }>;
        }
      >;
    };

    const unitJob = parsed.jobs["unit-tests"];
    const integrationJob = parsed.jobs["integration-tests"];
    expect(unitJob).toBeDefined();
    expect(integrationJob).toBeDefined();

    const unitRuns = (unitJob?.steps ?? []).map((s) => s.run ?? "").join("\n");
    expect(unitRuns).toContain("pnpm test:workspace:coverage");
    expect(unitRuns).toContain("pnpm coverage:ratchet");

    const reportStep = unitJob?.steps.find((s) => s.uses === "./.github/actions/coverage-report");
    expect(reportStep).toBeDefined();
    expect(reportStep?.if).toBe("always()");

    expect(integrationJob?.env?.REQUIRE_DATABASE_TESTS).toBe("1");
    expect(integrationJob?.env?.TEST_DATABASE_URL).toBeUndefined();
  });

  it("defines a valid composite action in .github/actions/coverage-report/action.yml", async () => {
    const actionPath = path.resolve(REPO_ROOT, ".github/actions/coverage-report/action.yml");
    const parsed = parseYaml(await fs.readFile(actionPath, "utf-8")) as {
      name: string;
      inputs: Record<string, { default?: string }>;
      runs: { using: string; steps: Array<{ run?: string; uses?: string }> };
    };

    expect(parsed.runs.using).toBe("composite");
    expect(parsed.inputs["summary-path"]?.default).toBe("coverage/coverage-summary.json");
    expect(parsed.inputs["ratchet-markdown-path"]?.default).toBe("coverage/ratchet-summary.md");

    const scriptContent = parsed.runs.steps.map((s) => s.run ?? "").join("\n");
    expect(scriptContent).toContain("::notice title=Coverage Summary::");
    expect(scriptContent).toContain("GITHUB_STEP_SUMMARY");
  });
});
