/**
 * Workspace-wide coverage aggregation (Issue 412).
 *
 * Scans all packages and apps for per-package coverage artifacts (coverage-final.json,
 * lcov.info), merges them into a single monorepo-wide coverage report, calculates
 * both aggregate metrics and a per-package breakdown, and outputs:
 * - Merged LCOV file (`coverage/lcov.info`)
 * - Unified JSON summary (`coverage/coverage-summary.json`)
 * - Standalone HTML dashboard (`coverage/index.html`)
 * - Formatted Markdown summary table for PR comments and CI step summaries.
 *
 * Usage:
 *   tsx infra/ci/coverage-merge.ts [--output-dir <path>] [--summary-markdown <path>]
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

export interface MetricSummary {
  total: number;
  covered: number;
  skipped: number;
  pct: number;
}

export interface CoverageEntry {
  lines: MetricSummary;
  functions: MetricSummary;
  branches: MetricSummary;
  statements: MetricSummary;
}

export interface WorkspaceCoverageReport {
  timestamp: string;
  aggregate: CoverageEntry;
  packages: Record<string, CoverageEntry>;
  totalFiles: number;
}

function calculateMetric(covered: number, total: number, skipped = 0): MetricSummary {
  const pct = total === 0 ? 100 : Number(((covered / total) * 100).toFixed(2));
  return {
    total,
    covered,
    skipped,
    pct,
  };
}

/**
 * Parses an LCOV string and computes metrics for lines, functions, and branches.
 */
export function parseLcovString(lcovContent: string): Record<string, CoverageEntry> {
  const files: Record<string, CoverageEntry> = {};
  const records = lcovContent.split("end_of_record");

  for (const record of records) {
    const trimmed = record.trim();
    if (!trimmed) {
      continue;
    }

    let currentFile = "";
    let linesFound = 0;
    let linesHit = 0;
    let fnFound = 0;
    let fnHit = 0;
    let brFound = 0;
    let brHit = 0;

    for (const line of trimmed.split("\n")) {
      const lineTrim = line.trim();
      if (lineTrim.startsWith("SF:")) {
        currentFile = lineTrim.slice(3);
      } else if (lineTrim.startsWith("LF:")) {
        linesFound = Number.parseInt(lineTrim.slice(3), 10) || 0;
      } else if (lineTrim.startsWith("LH:")) {
        linesHit = Number.parseInt(lineTrim.slice(3), 10) || 0;
      } else if (lineTrim.startsWith("FNF:")) {
        fnFound = Number.parseInt(lineTrim.slice(4), 10) || 0;
      } else if (lineTrim.startsWith("FNH:")) {
        fnHit = Number.parseInt(lineTrim.slice(4), 10) || 0;
      } else if (lineTrim.startsWith("BRF:")) {
        brFound = Number.parseInt(lineTrim.slice(4), 10) || 0;
      } else if (lineTrim.startsWith("BRH:")) {
        brHit = Number.parseInt(lineTrim.slice(4), 10) || 0;
      }
    }

    if (currentFile) {
      files[currentFile] = {
        lines: calculateMetric(linesHit, linesFound),
        functions: calculateMetric(fnHit, fnFound),
        branches: calculateMetric(brHit, brFound),
        statements: calculateMetric(linesHit, linesFound),
      };
    }
  }

  return files;
}

function packageName(fullPath: string, fallback: string): string {
  const packageJsonPath = path.join(fullPath, "package.json");
  if (!existsSync(packageJsonPath)) {
    return fallback;
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
    if (typeof parsed === "object" && parsed !== null && "name" in parsed) {
      const name = (parsed as { name?: unknown }).name;
      if (typeof name === "string" && name.length > 0) {
        return name;
      }
    }
  } catch {
    return fallback;
  }

  return fallback;
}

/**
 * Discovers coverage directories across packages/* and apps/*.
 */
export function findPackageCoverageDirs(repoRoot: string): Array<{ name: string; dir: string }> {
  const dirs: Array<{ name: string; dir: string }> = [];

  for (const group of ["packages", "apps", "tests"]) {
    const groupDir = path.join(repoRoot, group);
    if (!existsSync(groupDir)) {
      continue;
    }

    if (group === "tests") {
      const covDir = path.join(groupDir, "coverage");
      if (existsSync(covDir)) {
        dirs.push({ name: "tests/integration", dir: covDir });
      }
      continue;
    }

    const entries = readdirSync(groupDir);
    for (const entry of entries) {
      const fullPath = path.join(groupDir, entry);
      if (statSync(fullPath).isDirectory()) {
        const covDir = path.join(fullPath, "coverage");
        if (existsSync(covDir)) {
          dirs.push({ name: packageName(fullPath, `${group}/${entry}`), dir: covDir });
        }
      }
    }
  }

  return dirs;
}

/**
 * Aggregates coverage entries into a WorkspaceCoverageReport.
 */
export function aggregateCoverage(
  packageEntries: Array<{ name: string; files: Record<string, CoverageEntry> }>,
): WorkspaceCoverageReport {
  let totalLinesFound = 0;
  let totalLinesHit = 0;
  let totalFnFound = 0;
  let totalFnHit = 0;
  let totalBrFound = 0;
  let totalBrHit = 0;
  let totalFileCount = 0;

  const packages: Record<string, CoverageEntry> = {};

  for (const pkg of packageEntries) {
    let pkgLinesFound = 0;
    let pkgLinesHit = 0;
    let pkgFnFound = 0;
    let pkgFnHit = 0;
    let pkgBrFound = 0;
    let pkgBrHit = 0;

    const fileKeys = Object.keys(pkg.files);
    totalFileCount += fileKeys.length;

    for (const fileKey of fileKeys) {
      const f = pkg.files[fileKey];
      if (!f) {
        continue;
      }
      pkgLinesFound += f.lines.total;
      pkgLinesHit += f.lines.covered;
      pkgFnFound += f.functions.total;
      pkgFnHit += f.functions.covered;
      pkgBrFound += f.branches.total;
      pkgBrHit += f.branches.covered;
    }

    packages[pkg.name] = {
      lines: calculateMetric(pkgLinesHit, pkgLinesFound),
      functions: calculateMetric(pkgFnHit, pkgFnFound),
      branches: calculateMetric(pkgBrHit, pkgBrFound),
      statements: calculateMetric(pkgLinesHit, pkgLinesFound),
    };

    totalLinesFound += pkgLinesFound;
    totalLinesHit += pkgLinesHit;
    totalFnFound += pkgFnFound;
    totalFnHit += pkgFnHit;
    totalBrFound += pkgBrFound;
    totalBrHit += pkgBrHit;
  }

  return {
    timestamp: new Date().toISOString(),
    aggregate: {
      lines: calculateMetric(totalLinesHit, totalLinesFound),
      functions: calculateMetric(totalFnHit, totalFnFound),
      branches: calculateMetric(totalBrHit, totalBrFound),
      statements: calculateMetric(totalLinesHit, totalLinesFound),
    },
    packages,
    totalFiles: totalFileCount,
  };
}

/**
 * Generates Markdown summary table for PR comments and CI output.
 */
export function generateMarkdownSummary(report: WorkspaceCoverageReport): string {
  const { aggregate, packages } = report;

  const statusBadge = (pct: number) => {
    if (pct >= 85) return "🟢";
    if (pct >= 70) return "🟡";
    return "🔴";
  };

  const lines = [
    "## 📊 Workspace Coverage Aggregate Report",
    "",
    `**Generated:** ${report.timestamp}`,
    "",
    "### Monorepo Aggregate",
    "",
    "| Metric | Covered / Total | Percentage | Health |",
    "| :--- | :---: | :---: | :---: |",
    `| **Lines** | ${aggregate.lines.covered} / ${aggregate.lines.total} | ${aggregate.lines.pct}% | ${statusBadge(aggregate.lines.pct)} |`,
    `| **Statements** | ${aggregate.statements.covered} / ${aggregate.statements.total} | ${aggregate.statements.pct}% | ${statusBadge(aggregate.statements.pct)} |`,
    `| **Functions** | ${aggregate.functions.covered} / ${aggregate.functions.total} | ${aggregate.functions.pct}% | ${statusBadge(aggregate.functions.pct)} |`,
    `| **Branches** | ${aggregate.branches.covered} / ${aggregate.branches.total} | ${aggregate.branches.pct}% | ${statusBadge(aggregate.branches.pct)} |`,
    "",
    "### Per-Package Breakdown",
    "",
    "| Package / Component | Lines | Statements | Functions | Branches | Status |",
    "| :--- | :---: | :---: | :---: | :---: | :---: |",
  ];

  const sortedPkgs = Object.keys(packages).sort();
  for (const pkgName of sortedPkgs) {
    const p = packages[pkgName];
    if (!p) {
      continue;
    }
    lines.push(
      `| \`${pkgName}\` | ${p.lines.pct}% (${p.lines.covered}/${p.lines.total}) | ${p.statements.pct}% | ${p.functions.pct}% | ${p.branches.pct}% | ${statusBadge(p.lines.pct)} |`,
    );
  }

  lines.push("", "> Generated by `infra/ci/coverage-merge.ts` (Issue 412).");
  return lines.join("\n");
}

/**
 * Generates a clean HTML report dashboard.
 */
export function generateHtmlDashboard(report: WorkspaceCoverageReport): string {
  const { aggregate, packages } = report;

  const rows = Object.keys(packages)
    .sort()
    .map((name) => {
      const p = packages[name];
      if (!p) {
        return "";
      }
      return `<tr>
        <td><code>${name}</code></td>
        <td>${p.lines.pct}% (${p.lines.covered}/${p.lines.total})</td>
        <td>${p.statements.pct}%</td>
        <td>${p.functions.pct}%</td>
        <td>${p.branches.pct}%</td>
      </tr>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Verixa Monorepo Coverage Dashboard</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 2rem; background: #0d1117; color: #c9d1d9; }
    h1, h2 { color: #f0f6fc; }
    .cards { display: flex; gap: 1rem; margin-bottom: 2rem; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 1.5rem; flex: 1; }
    .card .val { font-size: 2rem; font-weight: bold; color: #58a6ff; }
    table { width: 100%; border-collapse: collapse; background: #161b22; border-radius: 6px; overflow: hidden; border: 1px solid #30363d; }
    th, td { padding: 0.75rem 1rem; text-align: left; border-bottom: 1px solid #30363d; }
    th { background: #21262d; color: #f0f6fc; }
    code { background: #21262d; padding: 0.2rem 0.4rem; border-radius: 3px; font-family: ui-monospace, SFMono-Regular, monospace; }
  </style>
</head>
<body>
  <h1>Verixa Coverage Dashboard</h1>
  <p>Merged workspace coverage report generated at ${report.timestamp}</p>
  <div class="cards">
    <div class="card"><div>Lines</div><div class="val">${aggregate.lines.pct}%</div><div>${aggregate.lines.covered}/${aggregate.lines.total}</div></div>
    <div class="card"><div>Statements</div><div class="val">${aggregate.statements.pct}%</div><div>${aggregate.statements.covered}/${aggregate.statements.total}</div></div>
    <div class="card"><div>Functions</div><div class="val">${aggregate.functions.pct}%</div><div>${aggregate.functions.covered}/${aggregate.functions.total}</div></div>
    <div class="card"><div>Branches</div><div class="val">${aggregate.branches.pct}%</div><div>${aggregate.branches.covered}/${aggregate.branches.total}</div></div>
  </div>
  <h2>Per-Package Coverage</h2>
  <table>
    <thead>
      <tr><th>Package</th><th>Lines</th><th>Statements</th><th>Functions</th><th>Branches</th></tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
</body>
</html>`;
}

/**
 * Main execution logic.
 */
export function runCoverageMerge(
  options: {
    repoRoot?: string | undefined;
    outputDir?: string | undefined;
    markdownSummaryPath?: string | undefined;
    jsonSummaryPath?: string | undefined;
    printSummary?: boolean | undefined;
  } = {},
): WorkspaceCoverageReport {
  const repoRoot = options.repoRoot ?? process.cwd();
  const outputDir = options.outputDir ?? path.join(repoRoot, "coverage");
  mkdirSync(outputDir, { recursive: true });

  const pkgDirs = findPackageCoverageDirs(repoRoot);
  const packageEntries: Array<{ name: string; files: Record<string, CoverageEntry> }> = [];
  const mergedLcovParts: string[] = [];

  for (const pkg of pkgDirs) {
    const lcovFile = path.join(pkg.dir, "lcov.info");
    if (existsSync(lcovFile)) {
      const content = readFileSync(lcovFile, "utf-8");
      mergedLcovParts.push(content);
      const files = parseLcovString(content);
      packageEntries.push({ name: pkg.name, files });
    }
  }

  const report = aggregateCoverage(packageEntries);

  // Write merged LCOV
  const mergedLcovPath = path.join(outputDir, "lcov.info");
  writeFileSync(mergedLcovPath, mergedLcovParts.join("\n"), "utf-8");

  // Write summary JSON
  const summaryJsonPath = options.jsonSummaryPath ?? path.join(outputDir, "coverage-summary.json");
  writeFileSync(
    summaryJsonPath,
    JSON.stringify({ ...report, total: report.aggregate }, null, 2),
    "utf-8",
  );

  // Write HTML dashboard
  const htmlPath = path.join(outputDir, "index.html");
  writeFileSync(htmlPath, generateHtmlDashboard(report), "utf-8");

  // Generate markdown summary
  const markdown = generateMarkdownSummary(report);
  if (options.markdownSummaryPath) {
    writeFileSync(options.markdownSummaryPath, markdown, "utf-8");
  }

  // If in GitHub Actions, append to GITHUB_STEP_SUMMARY
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      writeFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + "\n", { flag: "a" });
    } catch {
      // Ignored if step summary file is inaccessible
    }
  }

  if (options.printSummary || process.argv.includes("--print-summary")) {
    console.log(markdown);
  }

  return report;
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const printSummary = process.argv.includes("--print-summary");
  const markdownIdx = process.argv.indexOf("--summary-markdown");
  const markdownSummaryPath = markdownIdx !== -1 ? process.argv[markdownIdx + 1] : undefined;
  const outputIdx = process.argv.indexOf("--output-dir");
  const outputDir = outputIdx !== -1 ? process.argv[outputIdx + 1] : undefined;

  try {
    runCoverageMerge({
      printSummary,
      markdownSummaryPath,
      outputDir,
    });
  } catch (err: unknown) {
    console.error("Failed to merge coverage:", err);
    process.exit(1);
  }
}
