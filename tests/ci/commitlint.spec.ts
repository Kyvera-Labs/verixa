import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { REPO_ROOT } from "./helpers/ci-tooling.js";

function lintCommitMessage(message: string): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const bin = path.resolve(
    REPO_ROOT,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "commitlint.cmd" : "commitlint",
  );
  const result = spawnSync(bin, ["--config", "commitlint.config.cjs"], {
    cwd: REPO_ROOT,
    input: `${message}\n`,
    encoding: "utf-8",
    shell: process.platform === "win32",
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("Conventional Commit & PR-title lint enforcement (#479)", () => {
  const validMessages = [
    "feat: add structured pino logger to shared-kernel",
    "feat(auth): support pkce code challenge verification",
    "fix: correct redaction path for nested tokens",
    "fix(sessions)!: drop legacy opaque refresh token format",
    "docs(ci): document coverage gate and PR title linting",
    "refactor(identity): simplify user repository lookup",
    "test(audit): add chain tampering regression fixtures",
    "chore: update lockfile after security patch",
    "ci: run testcontainers integration suite in dedicated job",
    "perf(database): add partial index on active sessions",
    "revert: revert feat(auth): experimental token format",
  ];

  const invalidMessages = [
    "updates",
    "wip",
    "Added new feature without conventional prefix",
    "FEAT: uppercase type is not allowed",
    "unknown: disallowed commit type",
    "feat:",
    "feat: subject ending with a period.",
    `feat: ${"a".repeat(100)}`,
  ];

  it.each(validMessages)(
    "accepts valid Conventional Commit header: %s",
    (msg) => {
      const res = lintCommitMessage(msg);
      expect(res.status, `Expected valid commit to pass, got:\n${res.stdout}\n${res.stderr}`).toBe(
        0,
      );
    },
    15_000,
  );

  it.each(invalidMessages)(
    "rejects invalid commit header: %s",
    (msg) => {
      const res = lintCommitMessage(msg);
      expect(res.status, `Expected invalid commit "${msg}" to fail`).not.toBe(0);
    },
    15_000,
  );

  it("configures .github/workflows/commitlint.yml to lint PR titles on title edits", async () => {
    const workflowPath = path.resolve(REPO_ROOT, ".github/workflows/commitlint.yml");
    const raw = await fs.readFile(workflowPath, "utf-8");
    const parsed = parseYaml(raw) as {
      on: { pull_request: { types: string[] } };
      jobs: Record<string, { steps: Array<{ run?: string; uses?: string }> }>;
    };

    expect(parsed.on.pull_request.types).toEqual(
      expect.arrayContaining(["opened", "edited", "synchronize", "reopened"]),
    );
    const prTitleJob = parsed.jobs["pr-title"];
    expect(prTitleJob).toBeDefined();
    expect(parsed.jobs["commitlint"]).toBeDefined();

    const prTitleRuns = (prTitleJob?.steps ?? []).map((s) => s.run ?? "").join("\n");
    expect(prTitleRuns).toContain("commitlint --config commitlint.config.cjs");
  });
});
