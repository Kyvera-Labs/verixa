/**
 * Test-suite performance budget gate (Issue 415).
 *
 * The gate's job is to fail a PR that makes the suite meaningfully slower, and
 * to say which suite and by how much. These cases pin down each rule of
 * `infra/ci/perf-budget.ts`: within tolerance passes, over tolerance fails, a
 * budgeted suite that was never timed fails, a new unbudgeted suite is
 * reported without failing, and a baseline the gate cannot read is an input
 * error (exit 2), never a pass.
 *
 * Each case asserts on the message as well as the exit code, for the same
 * reason the other gates in this directory do: a failure nobody can interpret
 * gets bypassed.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createOutputDirectory, runPerfBudget } from "./helpers/ci-tooling.js";

const outputs: { directory: string; dispose(): void }[] = [];

afterAll(() => {
  for (const output of outputs) {
    output.dispose();
  }
});

/** Writes the given baseline and timings to a fresh directory and returns their paths. */
function workspace(files: { baseline?: unknown; timings?: unknown; rawBaseline?: string }): {
  readonly directory: string;
  readonly baseline: string;
  readonly timings: string;
} {
  const output = createOutputDirectory();
  outputs.push(output);
  const baseline = join(output.directory, "perf-baseline.json");
  const timings = join(output.directory, "timings.json");
  if (files.rawBaseline !== undefined) {
    writeFileSync(baseline, files.rawBaseline, "utf8");
  } else if (files.baseline !== undefined) {
    writeFileSync(baseline, JSON.stringify(files.baseline), "utf8");
  }
  if (files.timings !== undefined) {
    writeFileSync(timings, JSON.stringify(files.timings), "utf8");
  }
  return { directory: output.directory, baseline, timings };
}

const BASELINE = {
  tolerancePercent: 20,
  suites: { unit: { baselineSeconds: 100 }, integration: { baselineSeconds: 50 } },
};

const timed = (seconds: Record<string, number>): unknown => ({
  suites: Object.fromEntries(
    Object.entries(seconds).map(([suite, s]) => [suite, { seconds: s, exitCode: 0 }]),
  ),
});

// Every case spawns the CLI through tsx, so the clock is mostly process launch
// and TypeScript transform, not the work being tested. Under a loaded machine
// (the suite runs files in parallel) that exceeded the 5s default, so the
// suites get the same 30s ceiling as sbom.spec.ts.
const SPAWNING_SUITE = { timeout: 30_000 };

describe("perf-budget check", SPAWNING_SUITE, () => {
  it("passes when every suite is within baseline + tolerance, including exactly at the limit", () => {
    const files = workspace({ baseline: BASELINE, timings: timed({ unit: 120, integration: 41 }) });

    const result = runPerfBudget([
      "check",
      "--baseline",
      files.baseline,
      "--timings",
      files.timings,
    ]);

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("| unit | 100s | 120s | 120s | +20% | ✅ within budget |");
    expect(result.stdout).toContain("| integration | 50s | 60s | 41s | -18% | ✅ within budget |");
  });

  it("fails and names the suite, the time, the limit and the slowdown when a suite regresses", () => {
    const files = workspace({
      baseline: BASELINE,
      timings: timed({ unit: 120.5, integration: 40 }),
    });

    const result = runPerfBudget([
      "check",
      "--baseline",
      files.baseline,
      "--timings",
      files.timings,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'suite "unit" took 120.5s, over its limit of 120s (baseline 100s + 20% tolerance; 20.5% slower than baseline)',
    );
    expect(result.stderr).not.toContain('"integration"');
    expect(result.stdout).toContain("❌ regressed");
  });

  it("fails when a budgeted suite has no timing, so a suite cannot silently drop out of the budget", () => {
    const files = workspace({ baseline: BASELINE, timings: timed({ unit: 90 }) });

    const result = runPerfBudget([
      "check",
      "--baseline",
      files.baseline,
      "--timings",
      files.timings,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'suite "integration" has a baseline but no timing was recorded',
    );
    expect(result.stdout).toContain("| integration | 50s | 60s | – | – | ❌ not measured |");
  });

  it("reports a timed suite with no baseline without failing, since a new suite has no history yet", () => {
    const files = workspace({
      baseline: BASELINE,
      timings: timed({ unit: 90, integration: 40, e2e: 30 }),
    });

    const result = runPerfBudget([
      "check",
      "--baseline",
      files.baseline,
      "--timings",
      files.timings,
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("| e2e | – | – | 30s | – | ⚠️ no baseline |");
    expect(result.stdout).toContain('suite "e2e" has no baseline yet');
  });

  it("appends the table to the step summary and writes the JSON report", () => {
    const files = workspace({ baseline: BASELINE, timings: timed({ unit: 130, integration: 40 }) });
    const summary = join(files.directory, "summary.md");
    const report = join(files.directory, "report", "perf-report.json");
    writeFileSync(summary, "earlier step output\n", "utf8");

    const result = runPerfBudget([
      "check",
      "--baseline",
      files.baseline,
      "--timings",
      files.timings,
      "--summary",
      summary,
      "--report",
      report,
    ]);

    expect(result.exitCode).toBe(1);
    const summaryText = readFileSync(summary, "utf8");
    expect(summaryText.startsWith("earlier step output\n")).toBe(true);
    expect(summaryText).toContain("### Test suite duration");
    const parsed = JSON.parse(readFileSync(report, "utf8")) as {
      passed: boolean;
      results: { suite: string; status: string; measuredSeconds: number; deltaPercent: number }[];
    };
    expect(parsed.passed).toBe(false);
    expect(parsed.results).toContainEqual(
      expect.objectContaining({
        suite: "unit",
        status: "regressed",
        measuredSeconds: 130,
        deltaPercent: 30,
      }),
    );
  });

  describe("unreadable input is an error (exit 2), never a pass", () => {
    it.each([
      ["is not JSON", "{ not json", "baseline file is not valid JSON"],
      [
        "has no tolerance",
        JSON.stringify({ suites: { unit: { baselineSeconds: 1 } } }),
        '"tolerancePercent" must be a number >= 0',
      ],
      [
        "has a negative tolerance",
        JSON.stringify({ tolerancePercent: -5, suites: { unit: { baselineSeconds: 1 } } }),
        '"tolerancePercent" must be a number >= 0',
      ],
      [
        "has no suites",
        JSON.stringify({ tolerancePercent: 10, suites: {} }),
        '"suites" must be an object with at least one suite',
      ],
      [
        "has a misspelled duration field",
        JSON.stringify({ tolerancePercent: 10, suites: { unit: { baselineSecs: 60 } } }),
        'suite "unit" "baselineSeconds" must be a positive number, found undefined',
      ],
    ])("baseline that %s", (_label, rawBaseline, message) => {
      const files = workspace({ rawBaseline, timings: timed({ unit: 1 }) });

      const result = runPerfBudget([
        "check",
        "--baseline",
        files.baseline,
        "--timings",
        files.timings,
      ]);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(message);
    });

    it("missing baseline file", () => {
      const files = workspace({ timings: timed({ unit: 1 }) });

      const result = runPerfBudget([
        "check",
        "--baseline",
        files.baseline,
        "--timings",
        files.timings,
      ]);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("baseline file not found");
    });

    it("unknown subcommand", () => {
      const result = runPerfBudget(["verify"]);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('unknown subcommand "verify"');
    });
  });

  it("the committed baseline parses", () => {
    const files = workspace({ timings: timed({ unit: 1, integration: 1 }) });

    const result = runPerfBudget([
      "check",
      "--baseline",
      "infra/ci/perf-baseline.json",
      "--timings",
      files.timings,
    ]);

    // Fast fake timings, so anything other than 0 means the real file is unreadable.
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });
});

describe("perf-budget measure", SPAWNING_SUITE, () => {
  it("records wall-clock time per suite, merges suites into one file, and passes the exit code through", () => {
    const files = workspace({});
    const sleepThenExit = (ms: number, code: number): string[] => [
      process.execPath,
      "-e",
      `setTimeout(() => process.exit(${String(code)}), ${String(ms)})`,
    ];

    const first = runPerfBudget([
      "measure",
      "--suite",
      "unit",
      "--timings",
      files.timings,
      "--",
      ...sleepThenExit(300, 0),
    ]);
    const second = runPerfBudget([
      "measure",
      "--suite",
      "integration",
      "--timings",
      files.timings,
      "--",
      ...sleepThenExit(50, 3),
    ]);

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(3);
    const recorded = JSON.parse(readFileSync(files.timings, "utf8")) as {
      suites: Record<string, { seconds: number; exitCode: number }>;
    };
    expect(Object.keys(recorded.suites).sort()).toEqual(["integration", "unit"]);
    expect(recorded.suites["unit"]?.seconds).toBeGreaterThanOrEqual(0.3);
    expect(recorded.suites["integration"]?.exitCode).toBe(3);
  });

  it("refuses to run without a command", () => {
    const files = workspace({});

    const result = runPerfBudget(["measure", "--suite", "unit", "--timings", files.timings]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("give the suite's command after `--`");
  });
});
