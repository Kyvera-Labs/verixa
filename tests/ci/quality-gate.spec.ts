/**
 * Code quality gate (infra/ci/quality-gate.mjs).
 *
 * Like the other CI gates, the deliverable is a command a workflow runs, so
 * every case spawns it and asserts on what a contributor would see: the exit
 * code and the message. The policy cases matter most. A `warn` gate must never
 * fail the check, a `block` gate must, and a blocking gate whose measurement
 * crashed must fail rather than quietly pass.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { QUALITY_GATES_CONFIG, REPO_ROOT, runQualityGate } from "./helpers/ci-tooling.js";

const scratch = mkdtempSync(join(tmpdir(), "verixa-quality-gate-"));
let counter = 0;

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function file(name: string, content: string): string {
  counter += 1;
  const path = join(scratch, `${String(counter)}-${name}`);
  writeFileSync(path, content);
  return path;
}

/** A results directory holding one `<gate>.json` per entry, as the workflow writes them. */
function resultDir(results: Record<string, unknown>): string {
  counter += 1;
  const dir = join(scratch, `results-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  for (const [gate, result] of Object.entries(results)) {
    writeFileSync(join(dir, `${gate}.json`), JSON.stringify(result));
  }
  return dir;
}

function config(gates: Record<string, unknown>): string {
  return file("quality-gates.json", JSON.stringify({ gates }));
}

const PASS = { findings: [], summary: "fine" };
const FAIL = {
  findings: [{ message: "problem", file: "packages/x/a.ts", line: 3 }],
  summary: "bad",
};

const lcovFor = (path: string, hits: Record<number, number>): string =>
  `SF:${join(REPO_ROOT, path)}\n${Object.entries(hits)
    .map(([line, n]) => `DA:${line},${String(n)}`)
    .join("\n")}\nend_of_record\n`;

const diffAdding = (path: string, start: number, count: number): string =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +${String(start)},${String(count)} @@\n`;

describe("report: the mode policy", () => {
  it("passes with warnings when only a warn gate has findings", () => {
    const result = runQualityGate([
      "report",
      "--config",
      config({ complexity: { mode: "warn" } }),
      "--results",
      resultDir({ complexity: FAIL }),
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("⚠️ warn");
    expect(result.stdout).toContain("::warning file=packages/x/a.ts,line=3");
  });

  it("fails when a block gate has findings, and annotates them as errors", () => {
    const result = runQualityGate([
      "report",
      "--config",
      config({ complexity: { mode: "block" } }),
      "--results",
      resultDir({ complexity: FAIL }),
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("❌ fail");
    expect(result.stdout).toContain("::error file=packages/x/a.ts,line=3");
  });

  it("fails closed when a block gate produced no result", () => {
    const result = runQualityGate([
      "report",
      "--config",
      config({ patchCoverage: { mode: "block" } }),
      "--results",
      resultDir({}),
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("did not produce a result");
  });

  it("reports a missing warn gate as not run, without failing", () => {
    const result = runQualityGate([
      "report",
      "--config",
      config({ patchCoverage: { mode: "warn" } }),
      "--results",
      resultDir({}),
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("not-run");
  });

  it("ignores a gate that is off, even when it has findings", () => {
    const result = runQualityGate([
      "report",
      "--config",
      config({ complexity: { mode: "off" } }),
      "--results",
      resultDir({ complexity: FAIL }),
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("::warning");
  });

  it("rejects an invalid mode instead of guessing", () => {
    const result = runQualityGate([
      "report",
      "--config",
      config({ complexity: { mode: "strict" } }),
      "--results",
      resultDir({ complexity: PASS }),
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("gates.complexity.mode must be one of off, warn, block");
  });

  it("says when a warn gate is planned to block", () => {
    const result = runQualityGate([
      "report",
      "--config",
      config({ complexity: { mode: "warn", blockFrom: "2026-12-02" } }),
      "--results",
      resultDir({ complexity: FAIL }),
    ]);
    expect(result.stdout).toContain("block from 2026-12-02");
  });

  it("writes the summary to GITHUB_STEP_SUMMARY when set", () => {
    const summary = file("summary.md", "");
    runQualityGate(
      [
        "report",
        "--config",
        config({ complexity: { mode: "warn" } }),
        "--results",
        resultDir({ complexity: PASS }),
      ],
      { GITHUB_STEP_SUMMARY: summary },
    );
    expect(readFileSync(summary, "utf8")).toContain("## Code quality");
  });

  it("accepts the repository's own configuration", () => {
    const result = runQualityGate([
      "report",
      "--config",
      QUALITY_GATES_CONFIG,
      "--results",
      resultDir({}),
    ]);
    expect(result.stderr).toBe("");
  });
});

describe("patch-coverage", () => {
  const path = "packages/widget/domain/widget.ts";

  function patch(hits: Record<number, number>, start: number, count: number, min = 80): unknown {
    const out = join(scratch, `patch-${String((counter += 1))}.json`);
    const result = runQualityGate([
      "patch-coverage",
      "--diff",
      file("diff.txt", diffAdding(path, start, count)),
      "--lcov",
      file("lcov.info", lcovFor(path, hits)),
      "--min",
      String(min),
      "--out",
      out,
    ]);
    expect(result.exitCode).toBe(0);
    return JSON.parse(readFileSync(out, "utf8"));
  }

  it("passes when the changed lines are covered", () => {
    expect(patch({ 10: 1, 11: 3 }, 10, 2)).toMatchObject({ findings: [] });
  });

  it("names each uncovered changed line when below the minimum", () => {
    const result = patch({ 10: 1, 11: 0, 12: 0 }, 10, 3) as {
      findings: { line: number }[];
      summary: string;
    };
    expect(result.summary).toContain("1/3");
    expect(result.findings.map((f) => f.line)).toEqual([11, 12]);
  });

  it("only counts executable lines, so comments and types do not dilute it", () => {
    // Lines 10-14 changed, but lcov only lists 12 as executable, and it ran.
    expect(patch({ 12: 1 }, 10, 5)).toMatchObject({ findings: [] });
  });

  it("ignores lines in unchanged parts of the file", () => {
    expect(patch({ 1: 0, 2: 0, 10: 1 }, 10, 1)).toMatchObject({ findings: [] });
  });
});

describe("package-coverage", () => {
  it("flags each package whose coverage run failed", () => {
    const out = join(scratch, "package-coverage.json");
    runQualityGate([
      "package-coverage",
      "--status",
      file("status.txt", "@verixa/identity 0\n@verixa/mfa 1\n"),
      "--out",
      out,
    ]);
    const result = JSON.parse(readFileSync(out, "utf8")) as { findings: { message: string }[] };
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.message).toContain("@verixa/mfa");
  });
});

describe("complexity", () => {
  it("keeps only the complexity rules from an ESLint report", () => {
    const out = join(scratch, "complexity.json");
    const eslint = [
      {
        filePath: join(REPO_ROOT, "packages/x/a.ts"),
        messages: [
          { ruleId: "complexity", line: 4, message: "Function has a complexity of 15." },
          { ruleId: "no-unused-vars", line: 9, message: "unused" },
        ],
      },
    ];
    runQualityGate([
      "complexity",
      "--eslint",
      file("eslint.json", JSON.stringify(eslint)),
      "--out",
      out,
    ]);
    expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({
      findings: [{ file: "packages/x/a.ts", line: 4 }],
    });
  });

  it("turns the configured limits into ESLint rule arguments", () => {
    const result = runQualityGate(["eslint-rule-args", "--config", QUALITY_GATES_CONFIG]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("complexity: [warn, 12]");
    expect(result.stdout).toContain("max-lines-per-function: [warn, {max: 80");
  });

  it("refuses a rule that is not a complexity limit", () => {
    const result = runQualityGate([
      "eslint-rule-args",
      "--config",
      config({ complexity: { mode: "warn", limits: { "no-eval": 0 } } }),
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("unknown complexity rule in config: no-eval");
  });
});

describe("pr-title", () => {
  function title(text: string, exitCode: number, output = ""): { findings: { message: string }[] } {
    const out = join(scratch, `title-${String((counter += 1))}.json`);
    runQualityGate([
      "pr-title",
      "--title",
      text,
      "--exit-code",
      String(exitCode),
      "--output",
      file("commitlint.txt", output),
      "--out",
      out,
    ]);
    return JSON.parse(readFileSync(out, "utf8")) as { findings: { message: string }[] };
  }

  it("passes a conventional title", () => {
    expect(title("fix(sessions): revoke refresh tokens on logout", 0).findings).toEqual([]);
  });

  it("explains a rejected title with commitlint's own reasons", () => {
    const result = title(
      "Updated stuff",
      1,
      "⧗   input: Updated stuff\n✖   subject may not be empty [subject-empty]\n✖   found 1 problems, 0 warnings\n",
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.message).toContain("subject may not be empty");
  });
});
