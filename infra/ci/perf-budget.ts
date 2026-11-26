/**
 * Test-suite performance budget (Issue 415).
 *
 * Two subcommands, both run by `ci.yml` and both usable locally:
 *
 * ```
 * tsx infra/ci/perf-budget.ts measure --suite <name> --timings <file> -- <command...>
 * tsx infra/ci/perf-budget.ts check --baseline <file> --timings <file>
 *                                   [--summary <file>] [--report <file>]
 * ```
 *
 * `measure` runs one suite's command and records its **wall-clock** time. It
 * times the process from outside, not by summing Vitest's per-test durations:
 * under parallel workers those overlap, so their sum says how much CPU the
 * tests used, not how long a contributor waits, and it shrinks whenever
 * parallelism grows. The command's exit code is passed through unchanged, so
 * a failing suite still fails its step.
 *
 * `check` compares the recorded timings to the committed baseline. A suite
 * over `baselineSeconds × (1 + tolerancePercent / 100)` is a regression. It
 * writes a Markdown table (appended to `$GITHUB_STEP_SUMMARY` in CI) and a
 * JSON report (uploaded as an artifact), then exits:
 *
 * - `0`: every budgeted suite is within tolerance
 * - `1`: at least one suite regressed, or a budgeted suite was never measured
 * - `2`: the baseline or timings file is missing or malformed, or the
 *   arguments are wrong. Same convention as `dependency-scan.mjs`: a gate
 *   that cannot read its input fails, it does not pass.
 *
 * Everything between reading the files and writing the output is a pure
 * function of its inputs (`parseBaseline` → `parseTimings` → `evaluate` →
 * `renderMarkdown`), so the rules are explicit and the subprocess tests in
 * `tests/ci/perf-budget.spec.ts` can pin each one down.
 *
 * Why the baseline is committed rather than fetched from the last `main` run
 * is in `docs/guides/testing/performance-budget.md`.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

/* ------------------------------------------------------------------ *
 * Contracts
 * ------------------------------------------------------------------ */

interface SuiteBaseline {
  /** Wall-clock seconds the suite took when the baseline was recorded. */
  readonly baselineSeconds: number;
}

interface Baseline {
  /** Allowed slowdown over `baselineSeconds` before a run counts as a regression. */
  readonly tolerancePercent: number;
  readonly suites: Readonly<Record<string, SuiteBaseline>>;
}

interface SuiteTiming {
  readonly seconds: number;
  readonly exitCode: number;
}

type Timings = Readonly<Record<string, SuiteTiming>>;

type SuiteStatus = "ok" | "regressed" | "not-measured" | "unbudgeted";

interface SuiteResult {
  readonly suite: string;
  readonly status: SuiteStatus;
  readonly baselineSeconds: number | null;
  readonly limitSeconds: number | null;
  readonly measuredSeconds: number | null;
  /** Measured relative to baseline, in percent. Negative means faster. */
  readonly deltaPercent: number | null;
}

interface Evaluation {
  readonly tolerancePercent: number;
  readonly passed: boolean;
  readonly results: readonly SuiteResult[];
}

/** Bad input: the baseline or timings could not be read, or the arguments are wrong. Exit 2. */
class BudgetInputError extends Error {}

/* ------------------------------------------------------------------ *
 * Parsing
 *
 * Both files arrive as `unknown` and are checked by hand. A budget gate that
 * quietly treated a typo'd field as "no budget" would pass every run while
 * looking like it enforced something.
 * ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveNumber(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new BudgetInputError(
      `${context} must be a positive number, found ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function parseBaseline(raw: unknown, source = "baseline"): Baseline {
  if (!isRecord(raw)) {
    throw new BudgetInputError(`${source}: expected a JSON object`);
  }

  const tolerancePercent = raw["tolerancePercent"];
  if (
    typeof tolerancePercent !== "number" ||
    !Number.isFinite(tolerancePercent) ||
    tolerancePercent < 0
  ) {
    throw new BudgetInputError(
      `${source}: "tolerancePercent" must be a number >= 0, found ${JSON.stringify(tolerancePercent)}`,
    );
  }

  const rawSuites = raw["suites"];
  if (!isRecord(rawSuites) || Object.keys(rawSuites).length === 0) {
    throw new BudgetInputError(`${source}: "suites" must be an object with at least one suite`);
  }

  const suites: Record<string, SuiteBaseline> = {};
  for (const [name, entry] of Object.entries(rawSuites)) {
    if (!isRecord(entry)) {
      throw new BudgetInputError(`${source}: suite "${name}" must be an object`);
    }
    suites[name] = {
      baselineSeconds: positiveNumber(
        entry["baselineSeconds"],
        `${source}: suite "${name}" "baselineSeconds"`,
      ),
    };
  }

  return { tolerancePercent, suites };
}

function parseTimings(raw: unknown, source = "timings"): Timings {
  if (!isRecord(raw) || !isRecord(raw["suites"])) {
    throw new BudgetInputError(`${source}: expected a JSON object with a "suites" object`);
  }

  const timings: Record<string, SuiteTiming> = {};
  for (const [name, entry] of Object.entries(raw["suites"])) {
    if (!isRecord(entry)) {
      throw new BudgetInputError(`${source}: suite "${name}" must be an object`);
    }
    const exitCode = entry["exitCode"];
    if (typeof exitCode !== "number" || !Number.isInteger(exitCode)) {
      throw new BudgetInputError(`${source}: suite "${name}" "exitCode" must be an integer`);
    }
    timings[name] = {
      seconds: positiveNumber(entry["seconds"], `${source}: suite "${name}" "seconds"`),
      exitCode,
    };
  }
  return timings;
}

/* ------------------------------------------------------------------ *
 * Evaluation
 * ------------------------------------------------------------------ */

const round = (value: number, places = 1): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/**
 * Compares timings to the baseline.
 *
 * - A suite in the baseline with no timing is a failure (`not-measured`). That
 *   is either a CI step that stopped running or a baseline entry that went
 *   stale, and both need someone to look. Passing would let a suite drop out
 *   of the budget without anyone noticing.
 * - A timed suite with no baseline entry is reported (`unbudgeted`) but does
 *   not fail. A new suite has no history yet, and blocking the PR that
 *   introduces it would force a number to be made up before one has been
 *   measured.
 */
function evaluate(baseline: Baseline, timings: Timings): Evaluation {
  const factor = 1 + baseline.tolerancePercent / 100;
  const results: SuiteResult[] = [];

  for (const [suite, { baselineSeconds }] of Object.entries(baseline.suites)) {
    const limitSeconds = round(baselineSeconds * factor);
    const timing = timings[suite];
    if (timing === undefined) {
      results.push({
        suite,
        status: "not-measured",
        baselineSeconds,
        limitSeconds,
        measuredSeconds: null,
        deltaPercent: null,
      });
      continue;
    }
    results.push({
      suite,
      status: timing.seconds > baselineSeconds * factor ? "regressed" : "ok",
      baselineSeconds,
      limitSeconds,
      measuredSeconds: round(timing.seconds),
      deltaPercent: round(((timing.seconds - baselineSeconds) / baselineSeconds) * 100),
    });
  }

  for (const [suite, timing] of Object.entries(timings)) {
    if (baseline.suites[suite] === undefined) {
      results.push({
        suite,
        status: "unbudgeted",
        baselineSeconds: null,
        limitSeconds: null,
        measuredSeconds: round(timing.seconds),
        deltaPercent: null,
      });
    }
  }

  const passed = results.every((r) => r.status === "ok" || r.status === "unbudgeted");
  return { tolerancePercent: baseline.tolerancePercent, passed, results };
}

/** One line per problem, written for the person whose PR just failed. */
function failureMessages(evaluation: Evaluation): string[] {
  const messages: string[] = [];
  for (const r of evaluation.results) {
    if (r.status === "regressed") {
      messages.push(
        `suite "${r.suite}" took ${String(r.measuredSeconds)}s, over its limit of ${String(r.limitSeconds)}s ` +
          `(baseline ${String(r.baselineSeconds)}s + ${String(evaluation.tolerancePercent)}% tolerance; ` +
          `${String(r.deltaPercent)}% slower than baseline)`,
      );
    } else if (r.status === "not-measured") {
      messages.push(
        `suite "${r.suite}" has a baseline but no timing was recorded. Run it through ` +
          `\`perf-budget.ts measure --suite ${r.suite}\`, or remove it from the baseline`,
      );
    }
  }
  return messages;
}

const STATUS_LABEL: Record<SuiteStatus, string> = {
  ok: "✅ within budget",
  regressed: "❌ regressed",
  "not-measured": "❌ not measured",
  unbudgeted: "⚠️ no baseline",
};

const cell = (value: number | null, suffix = ""): string =>
  value === null ? "–" : `${String(value)}${suffix}`;

const signed = (value: number | null): string =>
  value === null ? "–" : `${value > 0 ? "+" : ""}${String(value)}%`;

function renderMarkdown(evaluation: Evaluation): string {
  const lines = [
    "### Test suite duration",
    "",
    "| Suite | Baseline | Limit | This run | Change | Status |",
    "|---|---:|---:|---:|---:|---|",
    ...evaluation.results.map(
      (r) =>
        `| ${r.suite} | ${cell(r.baselineSeconds, "s")} | ${cell(r.limitSeconds, "s")} | ` +
        `${cell(r.measuredSeconds, "s")} | ${signed(r.deltaPercent)} | ${STATUS_LABEL[r.status]} |`,
    ),
    "",
    `Limit = baseline + ${String(evaluation.tolerancePercent)}% tolerance. ` +
      "Baseline: `infra/ci/perf-baseline.json`. " +
      "See `docs/guides/testing/performance-budget.md`.",
    "",
  ];
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new BudgetInputError(`${name} needs a value`);
  }
  return value;
}

function requiredFlag(argv: readonly string[], name: string): string {
  const value = flag(argv, name);
  if (value === undefined) {
    throw new BudgetInputError(`missing required ${name}`);
  }
  return value;
}

/**
 * Reads and parses a JSON input. Reads first and maps ENOENT, rather than
 * checking existsSync and then reading, so there is no window in which the
 * file can change between the check and the read (CodeQL js/file-system-race).
 */
/** Previously recorded timings, or none when this is the first suite measured. */
function readTimingsIfPresent(timingsFile: string): ReturnType<typeof parseTimings> {
  try {
    return parseTimings(readJson(timingsFile, "timings"), timingsFile);
  } catch (error) {
    if (error instanceof BudgetInputError && error.message.startsWith("timings file not found")) {
      return {};
    }
    throw error;
  }
}

function readJson(file: string, what: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new BudgetInputError(`${what} file not found: ${file}`);
    }
    throw error;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new BudgetInputError(
      `${what} file is not valid JSON: ${file} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/** Commands that only exist as `.cmd` shims on Windows. */
const WINDOWS_SHIMS = new Set(["pnpm", "npm", "npx"]);

function measure(argv: readonly string[]): number {
  const separator = argv.indexOf("--");
  const options = separator === -1 ? argv : argv.slice(0, separator);
  const command = separator === -1 ? [] : argv.slice(separator + 1);
  const suite = requiredFlag(options, "--suite");
  const timingsFile = path.resolve(requiredFlag(options, "--timings"));
  const [executable, ...args] = command;
  if (executable === undefined) {
    throw new BudgetInputError("measure: give the suite's command after `--`");
  }

  const started = process.hrtime.bigint();
  const child = spawnSync(executable, args, {
    stdio: "inherit",
    // Windows starts `pnpm` and friends through .cmd shims, which need a
    // shell. Only those: a shell would re-parse every other command line, and
    // a path with a space in it (`C:\Program Files\nodejs\node.exe`) or a
    // quoted script argument would arrive mangled.
    shell: process.platform === "win32" && WINDOWS_SHIMS.has(executable),
  });
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  const exitCode = child.status ?? 1;

  // Merged into the existing file so each suite can be measured in its own CI
  // step. A file left over from an earlier, unrelated run would be merged too,
  // which is why CI writes to a fresh path in the job's workspace.
  const existing = readTimingsIfPresent(timingsFile);
  const updated = { suites: { ...existing, [suite]: { seconds: round(seconds, 2), exitCode } } };
  mkdirSync(path.dirname(timingsFile), { recursive: true });
  writeFileSync(timingsFile, `${JSON.stringify(updated, null, 2)}\n`, "utf8");

  process.stdout.write(
    `perf-budget: suite "${suite}" took ${round(seconds, 2).toFixed(2)}s (exit ${String(exitCode)})\n`,
  );
  return exitCode;
}

function check(argv: readonly string[]): number {
  const baselineFile = path.resolve(requiredFlag(argv, "--baseline"));
  const timingsFile = path.resolve(requiredFlag(argv, "--timings"));
  const summaryFile = flag(argv, "--summary");
  const reportFile = flag(argv, "--report");

  const baseline = parseBaseline(readJson(baselineFile, "baseline"), baselineFile);
  const timings = parseTimings(readJson(timingsFile, "timings"), timingsFile);
  const evaluation = evaluate(baseline, timings);
  const markdown = renderMarkdown(evaluation);

  process.stdout.write(markdown);
  if (summaryFile !== undefined) {
    // Appended, not overwritten: `$GITHUB_STEP_SUMMARY` is shared by every
    // step in the job.
    appendFileSync(summaryFile, `${markdown}\n`, "utf8");
  }
  if (reportFile !== undefined) {
    const resolved = path.resolve(reportFile);
    mkdirSync(path.dirname(resolved), { recursive: true });
    writeFileSync(resolved, `${JSON.stringify(evaluation, null, 2)}\n`, "utf8");
  }

  for (const r of evaluation.results) {
    if (r.status === "unbudgeted") {
      process.stdout.write(
        `perf-budget: suite "${r.suite}" has no baseline yet; add it to the baseline once its timing is known\n`,
      );
    }
  }
  const failures = failureMessages(evaluation);
  for (const message of failures) {
    process.stderr.write(`perf-budget: ${message}\n`);
  }
  return failures.length === 0 ? 0 : 1;
}

function run(argv: readonly string[]): number {
  const [subcommand, ...rest] = argv;
  switch (subcommand) {
    case "measure":
      return measure(rest);
    case "check":
      return check(rest);
    default:
      throw new BudgetInputError(
        `unknown subcommand ${JSON.stringify(subcommand)}; expected "measure" or "check"`,
      );
  }
}

try {
  process.exitCode = run(process.argv.slice(2));
} catch (error) {
  if (error instanceof BudgetInputError) {
    process.stderr.write(`perf-budget: ${error.message}\n`);
    process.exitCode = 2;
  } else {
    throw error;
  }
}
