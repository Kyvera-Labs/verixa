import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Coverage metrics percentages enforced by the ratchet.
 */
export interface CoverageMetrics {
  lines: number;
  statements: number;
  functions: number;
  branches: number;
}

/**
 * Checked-in coverage baseline schema (Issue 413).
 */
export interface CoverageBaseline {
  version: number;
  updatedAt: string;
  tolerance: number;
  aggregate: CoverageMetrics;
  packages: Record<string, CoverageMetrics>;
}

export type RatchetStatus = "improved" | "maintained" | "regressed";

export interface MetricDifference {
  metric: keyof CoverageMetrics;
  current: number;
  baseline: number;
  delta: number;
  status: RatchetStatus;
}

export interface TargetComparisonResult {
  target: string;
  status: RatchetStatus;
  metrics: MetricDifference[];
}

export interface RatchetComparisonResult {
  passed: boolean;
  hasRegressions: boolean;
  overrideApplied: boolean;
  overrideReason?: string | undefined;
  tolerance: number;
  aggregate: TargetComparisonResult;
  packages: TargetComparisonResult[];
  regressions: TargetComparisonResult[];
}

export interface RatchetCliOptions {
  baselinePath?: string | undefined;
  summaryPath?: string | undefined;
  tolerance?: number | undefined;
  updateBaseline?: boolean | undefined;
  allowDrop?: boolean | undefined;
  overrideReason?: string | undefined;
  markdownPath?: string | undefined;
}

const METRIC_KEYS: (keyof CoverageMetrics)[] = ["lines", "statements", "functions", "branches"];

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Compares an observed metric set against a baseline set given a tolerance.
 */
export function compareMetricSet(
  target: string,
  current: CoverageMetrics,
  baseline: CoverageMetrics,
  tolerance: number,
): TargetComparisonResult {
  let targetStatus: RatchetStatus = "maintained";
  const metrics: MetricDifference[] = [];

  for (const key of METRIC_KEYS) {
    const curVal = current[key];
    const baseVal = baseline[key];
    const delta = round(curVal - baseVal, 2);

    let status: RatchetStatus = "maintained";
    if (delta < -tolerance) {
      status = "regressed";
    } else if (delta > 0) {
      status = "improved";
    }

    metrics.push({
      metric: key,
      current: curVal,
      baseline: baseVal,
      delta,
      status,
    });
  }

  if (metrics.some((m) => m.status === "regressed")) {
    targetStatus = "regressed";
  } else if (metrics.some((m) => m.status === "improved")) {
    targetStatus = "improved";
  }

  return {
    target,
    status: targetStatus,
    metrics,
  };
}

/**
 * Normalizes input coverage summary records into uniform CoverageMetrics.
 */
export function extractCoverageMetrics(raw: unknown): CoverageMetrics | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const getPct = (val: unknown): number => {
    if (typeof val === "number") return round(val, 2);
    if (val && typeof val === "object" && "pct" in val) {
      const pct = val.pct;
      if (typeof pct === "number") {
        return round(pct, 2);
      }
    }
    return 0;
  };

  return {
    lines: getPct(record["lines"]),
    statements: getPct(record["statements"]),
    functions: getPct(record["functions"]),
    branches: getPct(record["branches"]),
  };
}

/**
 * Evaluates full coverage comparison between current summary and checked-in baseline.
 */
export function compareCoverage(
  currentSummary: { total?: unknown; packages?: Record<string, unknown> },
  baseline: CoverageBaseline,
  options?: {
    tolerance?: number | undefined;
    allowDrop?: boolean | undefined;
    overrideReason?: string | undefined;
  },
): RatchetComparisonResult {
  const tolerance = options?.tolerance ?? baseline.tolerance ?? 0.1;
  const allowDrop = options?.allowDrop ?? false;
  const overrideReason = options?.overrideReason;

  const currentAggregateMetrics = extractCoverageMetrics(currentSummary.total) ?? {
    lines: 0,
    statements: 0,
    functions: 0,
    branches: 0,
  };

  const aggregateResult = compareMetricSet(
    "workspace (aggregate)",
    currentAggregateMetrics,
    baseline.aggregate,
    tolerance,
  );

  const packagesResults: TargetComparisonResult[] = [];
  const rawPackages = currentSummary.packages ?? {};

  for (const [pkgName, baseMetrics] of Object.entries(baseline.packages)) {
    const rawPkg = rawPackages[pkgName];
    const curMetrics = extractCoverageMetrics(rawPkg) ?? {
      lines: 0,
      statements: 0,
      functions: 0,
      branches: 0,
    };
    packagesResults.push(compareMetricSet(pkgName, curMetrics, baseMetrics, tolerance));
  }

  const regressions = [aggregateResult, ...packagesResults].filter((r) => r.status === "regressed");
  const hasRegressions = regressions.length > 0;
  const passed = !hasRegressions || allowDrop;

  const result: RatchetComparisonResult = {
    passed,
    hasRegressions,
    overrideApplied: allowDrop && hasRegressions,
    tolerance,
    aggregate: aggregateResult,
    packages: packagesResults,
    regressions,
  };

  if (overrideReason !== undefined) {
    result.overrideReason = overrideReason;
  }

  return result;
}

/**
 * Updates baseline metrics with improved current values.
 */
export function updateBaselineMetrics(
  baseline: CoverageBaseline,
  currentSummary: { total?: unknown; packages?: Record<string, unknown> },
  force = false,
): CoverageBaseline {
  const updated: CoverageBaseline = {
    version: baseline.version,
    updatedAt: new Date().toISOString(),
    tolerance: baseline.tolerance,
    aggregate: { ...baseline.aggregate },
    packages: { ...baseline.packages },
  };

  const curAggregate = extractCoverageMetrics(currentSummary.total);
  if (curAggregate) {
    for (const key of METRIC_KEYS) {
      if (force || curAggregate[key] > updated.aggregate[key]) {
        updated.aggregate[key] = curAggregate[key];
      }
    }
  }

  const rawPackages = currentSummary.packages ?? {};
  for (const [pkgName, curRaw] of Object.entries(rawPackages)) {
    const curPkg = extractCoverageMetrics(curRaw);
    if (!curPkg) continue;

    const basePkg = updated.packages[pkgName] ?? {
      lines: 0,
      statements: 0,
      functions: 0,
      branches: 0,
    };
    const mergedPkg = { ...basePkg };

    for (const key of METRIC_KEYS) {
      if (force || curPkg[key] > mergedPkg[key]) {
        mergedPkg[key] = curPkg[key];
      }
    }
    updated.packages[pkgName] = mergedPkg;
  }

  return updated;
}

/**
 * Formats ratchet comparison results as GitHub Flavored Markdown.
 */
export function formatRatchetMarkdown(result: RatchetComparisonResult): string {
  const lines: string[] = [];

  lines.push("## Coverage Ratchet Summary (Issue 413)");
  lines.push("");

  if (result.passed && !result.overrideApplied) {
    lines.push(
      "**All coverage ratchet gates satisfied.** No coverage regression detected beyond tolerance.",
    );
  } else if (result.passed && result.overrideApplied) {
    lines.push("**Coverage ratchet override applied.** Drops allowed by policy or override flag.");
    if (result.overrideReason) {
      lines.push(`> **Override Reason:** ${result.overrideReason}`);
    }
  } else {
    lines.push(
      "**Coverage ratchet check failed.** One or more targets regressed beyond the permitted tolerance.",
    );
  }

  lines.push("");
  lines.push(`- **Tolerance:** \`±${result.tolerance}%\``);
  lines.push("");

  lines.push("| Target | Lines | Statements | Functions | Branches | Status |");
  lines.push("| :--- | :---: | :---: | :---: | :---: | :---: |");

  const formatTargetRow = (targetResult: TargetComparisonResult): string => {
    const metricCols = METRIC_KEYS.map((k) => {
      const diff = targetResult.metrics.find((m) => m.metric === k);
      if (!diff) return "-";
      const sign = diff.delta > 0 ? "+" : "";
      return `${diff.current}% (\`${sign}${diff.delta}%\`)`;
    });

    let statusBadge = "Maintained";
    if (targetResult.status === "improved") {
      statusBadge = "Improved";
    } else if (targetResult.status === "regressed") {
      statusBadge = "Regressed";
    }

    return `| **${targetResult.target}** | ${metricCols.join(" | ")} | ${statusBadge} |`;
  };

  lines.push(formatTargetRow(result.aggregate));
  for (const pkg of result.packages) {
    lines.push(formatTargetRow(pkg));
  }

  lines.push("");

  if (result.hasRegressions && !result.passed) {
    lines.push("### Required Action");
    lines.push("");
    lines.push("Coverage dropped below the recorded baseline. To resolve this:");
    lines.push("1. Add unit or contract tests covering your new or modified code paths.");
    lines.push(
      "2. If a temporary drop is justified by an architectural refactor, an authorized maintainer can set `COVERAGE_RATCHET_OVERRIDE=true` in CI or pass `--allow-drop` with a rationale.",
    );
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Converts the summary `coverage-merge.ts` writes into the shape the ratchet compares: totals from
 * `aggregate` become `total`, and directory keys (`packages/audit`) become package names
 * (`@verixa/audit`) from each `package.json`. Keys that are already names, or whose manifest cannot
 * be read, are kept.
 */
export function normalizeCoverageSummary(
  raw: unknown,
  rootDir: string,
): { total?: unknown; packages?: Record<string, unknown> } {
  const summary = (raw ?? {}) as {
    total?: unknown;
    aggregate?: unknown;
    packages?: Record<string, unknown>;
  };

  const packages: Record<string, unknown> = {};
  for (const [key, metrics] of Object.entries(summary.packages ?? {})) {
    let name = key;
    if (!key.startsWith("@")) {
      const manifest = resolve(rootDir, key, "package.json");
      if (existsSync(manifest)) {
        const parsed = JSON.parse(readFileSync(manifest, "utf-8")) as { name?: unknown };
        if (typeof parsed.name === "string" && parsed.name !== "") name = parsed.name;
      }
    }
    packages[name] = metrics;
  }

  return { total: summary.total ?? summary.aggregate, packages };
}

/**
 * Main execution routine for the coverage ratchet CLI check.
 */
export function runCoverageRatchet(options: Partial<RatchetCliOptions> = {}): number {
  const rootDir = process.cwd();
  const baselinePath = resolve(rootDir, options.baselinePath ?? "infra/ci/coverage-baseline.json");
  const summaryPath = resolve(rootDir, options.summaryPath ?? "coverage/coverage-summary.json");
  const markdownPath = options.markdownPath ? resolve(rootDir, options.markdownPath) : undefined;

  if (!existsSync(baselinePath)) {
    console.error(`[coverage-ratchet] Error: Baseline file not found at ${baselinePath}`);
    return 1;
  }

  if (!existsSync(summaryPath)) {
    console.error(
      `[coverage-ratchet] Error: Coverage summary not found at ${summaryPath}. Did you run 'pnpm test:workspace:coverage'?`,
    );
    return 1;
  }

  const baseline: CoverageBaseline = JSON.parse(
    readFileSync(baselinePath, "utf-8"),
  ) as CoverageBaseline;
  const currentSummary = normalizeCoverageSummary(
    JSON.parse(readFileSync(summaryPath, "utf-8")),
    rootDir,
  );

  const envOverride = process.env["COVERAGE_RATCHET_OVERRIDE"];
  const allowDrop =
    options.allowDrop ?? (Boolean(envOverride) && envOverride !== "false" && envOverride !== "0");
  const overrideReason =
    options.overrideReason ??
    (typeof envOverride === "string" && envOverride !== "true" ? envOverride : undefined);

  const result = compareCoverage(currentSummary, baseline, {
    tolerance: options.tolerance,
    allowDrop,
    overrideReason,
  });

  const markdown = formatRatchetMarkdown(result);
  console.log(markdown);

  if (markdownPath) {
    writeFileSync(markdownPath, markdown, "utf-8");
  }

  if (options.updateBaseline && (result.passed || allowDrop)) {
    console.log("[coverage-ratchet] Updating baseline with improved numbers...");
    const updated = updateBaselineMetrics(baseline, currentSummary, allowDrop);
    writeFileSync(baselinePath, JSON.stringify(updated, null, 2) + "\n", "utf-8");
    console.log(`[coverage-ratchet] Baseline successfully updated at ${baselinePath}`);
  }

  return result.passed ? 0 : 1;
}

// Direct CLI invocation
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const cliOptions: Partial<RatchetCliOptions> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--update-baseline") {
      cliOptions.updateBaseline = true;
    } else if (arg === "--allow-drop") {
      cliOptions.allowDrop = true;
    } else if (arg === "--tolerance" && args[i + 1]) {
      cliOptions.tolerance = parseFloat(args[++i]!);
    } else if (arg === "--baseline" && args[i + 1]) {
      cliOptions.baselinePath = args[++i];
    } else if (arg === "--summary" && args[i + 1]) {
      cliOptions.summaryPath = args[++i];
    } else if (arg === "--output-markdown" && args[i + 1]) {
      cliOptions.markdownPath = args[++i];
    } else if (arg === "--override-reason" && args[i + 1]) {
      cliOptions.overrideReason = args[++i];
    }
  }

  try {
    const exitCode = runCoverageRatchet(cliOptions);
    process.exit(exitCode);
  } catch (err: unknown) {
    console.error("[coverage-ratchet] Fatal error:", err);
    process.exit(1);
  }
}
