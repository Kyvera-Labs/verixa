import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { REPO_ROOT } from "./helpers/ci-tooling.js";

interface ReleaseRule {
  breaking?: boolean;
  revert?: boolean;
  type?: string;
  release: string | false;
}

interface ReleaseConfig {
  branches: string[];
  plugins: Array<string | [string, { preset?: string; releaseRules?: ReleaseRule[] }]>;
}

describe("semantic-release configuration & workflow (#480)", () => {
  it("configures .releaserc.json on main with commit-analyzer, release-notes-generator, and github plugins", async () => {
    const rcPath = path.resolve(REPO_ROOT, ".releaserc.json");
    const config = JSON.parse(await fs.readFile(rcPath, "utf-8")) as ReleaseConfig;

    expect(config.branches).toEqual(["main"]);

    const pluginNames = config.plugins.map((p) => (Array.isArray(p) ? p[0] : p));
    expect(pluginNames).toEqual([
      "@semantic-release/commit-analyzer",
      "@semantic-release/release-notes-generator",
      "@semantic-release/github",
    ]);

    const analyzerEntry = config.plugins[0];
    expect(Array.isArray(analyzerEntry)).toBe(true);
    if (Array.isArray(analyzerEntry)) {
      const options = analyzerEntry[1];
      expect(options.preset).toBe("conventionalcommits");
      expect(options.releaseRules).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ breaking: true, release: "major" }),
          expect.objectContaining({ type: "feat", release: "minor" }),
          expect.objectContaining({ type: "fix", release: "patch" }),
          expect.objectContaining({ type: "docs", release: false }),
          expect.objectContaining({ type: "chore", release: false }),
        ]),
      );
    }
  });

  it("runs semantic-release only by hand, on main, from the lockfile", async () => {
    // A release is a maintainer decision. Running on every push to main would
    // publish a release per merge, and deploy.yml follows the "Release"
    // workflow, so it would also try to deploy each one.
    const workflowPath = path.resolve(REPO_ROOT, ".github/workflows/semantic-release.yml");
    const parsed = parseYaml(await fs.readFile(workflowPath, "utf-8")) as {
      name: string;
      on: Record<string, unknown>;
      jobs: Record<string, { if?: string; steps: Array<{ run?: string }> }>;
    };

    expect(Object.keys(parsed.on)).toEqual(["workflow_dispatch"]);
    expect(parsed.name).not.toBe("Release");

    const releaseJob = parsed.jobs["release"];
    expect(releaseJob).toBeDefined();
    expect(releaseJob?.if).toContain("refs/heads/main");

    const releaseRuns = (releaseJob?.steps ?? []).map((s) => s.run ?? "").join("\n");
    expect(releaseRuns).toContain("pnpm exec semantic-release");
    expect(releaseRuns).not.toContain("npx");
  });

  it("keeps the SBOM release workflow tag-triggered only", async () => {
    const workflowPath = path.resolve(REPO_ROOT, ".github/workflows/release.yml");
    const parsed = parseYaml(await fs.readFile(workflowPath, "utf-8")) as {
      on: { push: { branches?: string[]; tags: string[] } };
      jobs: Record<string, unknown>;
    };

    expect(parsed.on.push.branches).toBeUndefined();
    expect(parsed.on.push.tags).toContain("v[0-9]+.[0-9]+.[0-9]+");
    expect(parsed.jobs["semantic-release"]).toBeUndefined();
  });
});
