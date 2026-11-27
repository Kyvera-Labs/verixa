#!/usr/bin/env node
/**
 * Code quality gate for contributor pull requests. Each measurement the workflow takes is turned
 * into a result file by a subcommand, and `report` judges all results against `quality-gates.json`:
 *
 * ```
 * node infra/ci/quality-gate.mjs patch-coverage --diff d.txt --lcov a.info [--lcov b.info] --min 80 --out r/patch.json
 * node infra/ci/quality-gate.mjs package-coverage --status s.txt --out r/coverage.json
 * node infra/ci/quality-gate.mjs complexity --eslint e.json --out r/complexity.json
 * node infra/ci/quality-gate.mjs pr-title --exit-code 1 --output o.txt --title "..." --out r/title.json
 * node infra/ci/quality-gate.mjs report --config infra/ci/quality-gates.json --results r/
 * ```
 *
 * Each gate has a mode, `off`, `warn` or `block`, so a new check can warn until it proves reliable.
 * A `block` gate with a missing or unreadable result fails; a `warn` gate in that state is reported
 * as not run. Dependency-free; it only reads files the workflow produced.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MODES = new Set(["off", "warn", "block"]);

/** Annotations beyond this many per gate add noise, not information. */
const MAX_ANNOTATIONS = 30;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Lines added by a unified diff (`git diff -U0`), as repo-relative path ->
 * set of new-file line numbers. Deleted files and pure deletions add nothing.
 */
export function parseAddedLines(diffText) {
  const added = new Map();
  let file = null;
  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      file = target === "/dev/null" ? null : target.replace(/^b\//, "");
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && file) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      if (count === 0) continue;
      const lines = added.get(file) ?? new Set();
      for (let n = start; n < start + count; n += 1) lines.add(n);
      added.set(file, lines);
    }
  }
  return added;
}

/**
 * Line hit counts from an lcov report, as repo-relative path -> (line -> hits).
 * Only lines lcov lists (`DA:`) are executable; anything else is a comment,
 * a type, a blank line, and does not count either way.
 */
export function parseLcov(lcovText, repoRoot) {
  const files = new Map();
  let current = null;
  for (const raw of lcovText.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      const source = line.slice(3);
      const absolute = isAbsolute(source) ? source : resolve(repoRoot, source);
      const path = relative(repoRoot, absolute).split("\\").join("/");
      current = files.get(path) ?? new Map();
      files.set(path, current);
    } else if (line.startsWith("DA:") && current) {
      const [lineNumber, hits] = line.slice(3).split(",");
      const n = Number(lineNumber);
      current.set(n, Math.max(current.get(n) ?? 0, Number(hits)));
    } else if (line === "end_of_record") {
      current = null;
    }
  }
  return files;
}

function mergeCoverage(maps) {
  const merged = new Map();
  for (const map of maps) {
    for (const [path, lines] of map) {
      const into = merged.get(path) ?? new Map();
      for (const [n, hits] of lines) into.set(n, Math.max(into.get(n) ?? 0, hits));
      merged.set(path, into);
    }
  }
  return merged;
}

const isTestFile = (path) =>
  /\.(spec|test)\.[cm]?[jt]sx?$/.test(path) || path.includes("/testing/");

// ---------------------------------------------------------------------------
// Measurements -> results
// ---------------------------------------------------------------------------

/**
 * Coverage of the changed lines only. Package-wide coverage can stay high
 * while a pull request adds a completely untested branch; this measures what
 * the pull request itself added.
 */
export function patchCoverage({ addedLines, coverage, minPercent }) {
  let executable = 0;
  let covered = 0;
  const uncovered = [];
  for (const [path, lines] of addedLines) {
    if (isTestFile(path)) continue;
    const hits = coverage.get(path);
    if (!hits) continue;
    for (const n of [...lines].sort((a, b) => a - b)) {
      if (!hits.has(n)) continue;
      executable += 1;
      if (hits.get(n) > 0) covered += 1;
      else uncovered.push({ file: path, line: n });
    }
  }
  const percent = executable === 0 ? 100 : Math.round((covered / executable) * 1000) / 10;
  const summary =
    executable === 0
      ? "No changed executable lines in covered packages."
      : `${String(covered)}/${String(executable)} changed executable lines covered (${String(percent)}%, minimum ${String(minPercent)}%).`;
  const findings =
    percent >= minPercent
      ? []
      : uncovered.map((u) => ({ ...u, message: "Changed line is not executed by any test." }));
  return { gate: "patchCoverage", summary, findings };
}

/** `<package> <exit code>` per line, as the workflow's coverage loop writes it. */
export function packageCoverage(statusText) {
  const findings = [];
  const ran = [];
  for (const line of statusText.split(/\r?\n/)) {
    const match = /^(\S+)\s+(\d+)\s*$/.exec(line.trim());
    if (!match) continue;
    ran.push(match[1]);
    if (match[2] !== "0") {
      findings.push({
        message: `${match[1]} is below its own coverage thresholds (see its vitest.config.ts), or its tests failed.`,
      });
    }
  }
  const summary =
    ran.length === 0
      ? "No changed package defines coverage thresholds."
      : `Checked ${String(ran.length)} changed package(s): ${ran.join(", ")}.`;
  return { gate: "packageCoverage", summary, findings };
}

const COMPLEXITY_RULES = new Set([
  "complexity",
  "max-depth",
  "max-lines-per-function",
  "max-params",
  "max-nested-callbacks",
]);

/**
 * ESLint `--rule` values (levn syntax) for the configured complexity limits.
 * Only known rules are emitted, so a typo in the config cannot inject an
 * arbitrary rule or option into the lint run.
 */
export function complexityRuleArgs(config) {
  const limits = config?.gates?.complexity?.limits ?? {};
  const args = [];
  for (const [rule, value] of Object.entries(limits)) {
    if (!COMPLEXITY_RULES.has(rule)) throw new Error(`unknown complexity rule in config: ${rule}`);
    if (!Number.isInteger(value) || value < 1)
      throw new Error(`limit for ${rule} must be a positive integer`);
    args.push(
      rule === "max-lines-per-function"
        ? `${rule}: [warn, {max: ${String(value)}, skipBlankLines: true, skipComments: true}]`
        : `${rule}: [warn, ${String(value)}]`,
    );
  }
  return args;
}

/** ESLint `--format json` output, restricted to the complexity rules. */
export function complexity(eslintResults, repoRoot) {
  const findings = [];
  for (const result of eslintResults) {
    const file = relative(repoRoot, result.filePath).split("\\").join("/");
    for (const message of result.messages ?? []) {
      if (!COMPLEXITY_RULES.has(message.ruleId)) continue;
      findings.push({
        file,
        line: message.line,
        message: `${message.message} (${message.ruleId})`,
      });
    }
  }
  const files = eslintResults.length;
  const summary =
    findings.length === 0
      ? `No complexity limits exceeded in ${String(files)} changed file(s).`
      : `${String(findings.length)} complexity limit(s) exceeded in changed code.`;
  return { gate: "complexity", summary, findings };
}

/** The pull request title becomes the squash-merge commit, so it is linted like one. */
export function prTitle({ title, exitCode, output }) {
  if (exitCode === 0)
    return { gate: "prTitle", summary: `\`${title}\` follows Conventional Commits.`, findings: [] };
  const reasons = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("✖"))
    .map((l) => l.replace(/^✖\s*/, ""))
    .filter((l) => !/^found \d+ problems?/.test(l));
  return {
    gate: "prTitle",
    summary: `\`${title}\` is not a Conventional Commit title.`,
    findings: (reasons.length > 0 ? reasons : ["does not match type(scope): subject"]).map((r) => ({
      message: `${r}. Example: "feat(identity): add email change use case".`,
    })),
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/** Validates `quality-gates.json`; returns a list of problems, empty when valid. */
export function validateConfig(config) {
  const problems = [];
  if (!config || typeof config.gates !== "object") return ["config must have a `gates` object"];
  for (const [name, gate] of Object.entries(config.gates)) {
    if (!MODES.has(gate?.mode)) problems.push(`gates.${name}.mode must be one of off, warn, block`);
  }
  return problems;
}

/**
 * Decides the outcome: which gates passed, warned or failed, and whether the
 * check as a whole fails. Pure, so the policy is tested without a workflow.
 */
export function evaluate(config, results) {
  const rows = [];
  let failed = false;
  for (const [name, gate] of Object.entries(config.gates)) {
    if (gate.mode === "off") {
      rows.push({
        name,
        mode: "off",
        status: "off",
        summary: "Disabled in quality-gates.json.",
        findings: [],
      });
      continue;
    }
    const result = results.get(name);
    if (!result) {
      const status = gate.mode === "block" ? "fail" : "not-run";
      if (status === "fail") failed = true;
      rows.push({
        name,
        mode: gate.mode,
        status,
        summary: "The measurement did not produce a result. A blocking gate fails closed.",
        findings: [],
      });
      continue;
    }
    const passed = result.findings.length === 0;
    const status = passed ? "pass" : gate.mode === "block" ? "fail" : "warn";
    if (status === "fail") failed = true;
    rows.push({
      name,
      mode: gate.mode,
      status,
      summary: result.summary,
      findings: result.findings,
      gate,
    });
  }
  return { failed, rows };
}

export function renderSummary(outcome) {
  const lines = [
    "## Code quality",
    "",
    "| Gate | Mode | Result | Detail |",
    "|---|---|---|---|",
    ...outcome.rows.map(
      (r) => `| \`${r.name}\` | ${r.mode} | ${r.status} | ${r.summary.replace(/\|/g, "\\|")} |`,
    ),
    "",
  ];
  for (const row of outcome.rows.filter((r) => r.findings.length > 0)) {
    const note = row.gate?.description ? `\n\n${row.gate.description}` : "";
    const later =
      row.mode === "warn" && row.gate?.blockFrom
        ? `\n\n> This gate warns for now and is planned to **block from ${row.gate.blockFrom}**.`
        : "";
    lines.push(`### \`${row.name}\`${note}${later}`, "");
    for (const f of row.findings.slice(0, MAX_ANNOTATIONS)) {
      lines.push(
        `- ${f.file ? `\`${f.file}${f.line ? `:${String(f.line)}` : ""}\` ` : ""}${f.message}`,
      );
    }
    if (row.findings.length > MAX_ANNOTATIONS) {
      lines.push(`- …and ${String(row.findings.length - MAX_ANNOTATIONS)} more.`);
    }
    lines.push("");
  }
  lines.push(
    outcome.failed
      ? "**Result: failed.** A gate in `block` mode found problems. Fix them, or discuss on the pull request if you believe the gate is wrong."
      : "**Result: passed.** Warnings above are advice from gates that are not blocking yet.",
  );
  return `${lines.join("\n")}\n`;
}

/** GitHub workflow-command annotations, so findings show on the changed lines. */
export function renderAnnotations(outcome) {
  const out = [];
  for (const row of outcome.rows) {
    if (row.status !== "warn" && row.status !== "fail") continue;
    const level = row.status === "fail" ? "error" : "warning";
    for (const f of row.findings.slice(0, MAX_ANNOTATIONS)) {
      const where = f.file ? ` file=${f.file}${f.line ? `,line=${String(f.line)}` : ""}` : "";
      const text = f.message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
      out.push(`::${level}${where},title=quality: ${row.name}::${text}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { _: [], lcov: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      args._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const value = argv[i + 1];
    i += 1;
    if (key === "lcov") args.lcov.push(value);
    else args[key] = value;
  }
  return args;
}

function required(args, key) {
  if (args[key] === undefined) throw new Error(`missing --${key}`);
  return args[key];
}

function writeResult(path, result) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${result.gate}: ${result.summary}\n`);
}

function readText(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

export function main(argv, { repoRoot = process.cwd(), env = process.env } = {}) {
  const args = parseArgs(argv);
  const command = args._[0];
  switch (command) {
    case "patch-coverage": {
      const result = patchCoverage({
        addedLines: parseAddedLines(readText(required(args, "diff"))),
        coverage: mergeCoverage(args.lcov.map((p) => parseLcov(readText(p), repoRoot))),
        minPercent: Number(args.min ?? 80),
      });
      writeResult(required(args, "out"), result);
      return 0;
    }
    case "package-coverage":
      writeResult(required(args, "out"), packageCoverage(readText(required(args, "status"))));
      return 0;
    case "complexity": {
      const text = readText(required(args, "eslint")).trim();
      writeResult(required(args, "out"), complexity(text ? JSON.parse(text) : [], repoRoot));
      return 0;
    }
    case "pr-title":
      writeResult(
        required(args, "out"),
        prTitle({
          title: args.title ?? "",
          exitCode: Number(required(args, "exit-code")),
          output: readText(args.output ?? ""),
        }),
      );
      return 0;
    case "eslint-rule-args": {
      // One `--rule` value per line, for the workflow to pass to ESLint, so
      // the limits live in quality-gates.json and not in the workflow.
      const config = JSON.parse(readFileSync(required(args, "config"), "utf8"));
      for (const line of complexityRuleArgs(config)) process.stdout.write(`${line}\n`);
      return 0;
    }
    case "report": {
      const config = JSON.parse(readFileSync(required(args, "config"), "utf8"));
      const problems = validateConfig(config);
      if (problems.length > 0) {
        process.stderr.write(
          `quality-gates.json is invalid:\n${problems.map((p) => `  - ${p}`).join("\n")}\n`,
        );
        return 1;
      }
      const directory = required(args, "results");
      const results = new Map();
      for (const name of Object.keys(config.gates)) {
        const path = resolve(directory, `${name}.json`);
        try {
          const parsed = JSON.parse(readFileSync(path, "utf8"));
          if (Array.isArray(parsed.findings)) results.set(name, parsed);
        } catch {
          // Missing or unreadable: evaluate() decides what that means per mode.
        }
      }
      const outcome = evaluate(config, results);
      const summary = renderSummary(outcome);
      process.stdout.write(summary);
      for (const line of renderAnnotations(outcome)) process.stdout.write(`${line}\n`);
      if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
      return outcome.failed ? 1 : 0;
    }
    default:
      process.stderr.write(
        "usage: quality-gate.mjs <patch-coverage|package-coverage|complexity|pr-title|report> [options]\n",
      );
      return 2;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    process.exit(
      main(process.argv.slice(2), {
        repoRoot: resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."),
      }),
    );
  } catch (error) {
    process.stderr.write(
      `quality-gate: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(2);
  }
}
