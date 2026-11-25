import { promises as fs } from "node:fs";

export interface WorkflowRun {
  readonly id: number;
  readonly name: string;
  readonly head_branch: string;
  readonly head_sha: string;
  readonly event: string;
  readonly status: "queued" | "in_progress" | "completed" | string;
  readonly conclusion:
    "success" | "failure" | "cancelled" | "skipped" | "timed_out" | string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly html_url: string;
  readonly run_number?: number | undefined;
  readonly run_started_at?: string | undefined;
  readonly actor?: {
    readonly login: string;
  };
  readonly head_commit?: {
    readonly id: string;
    readonly message: string;
    readonly author?: {
      readonly name?: string | undefined;
      readonly email?: string | undefined;
    };
  };
}

export interface WorkflowMetrics {
  readonly name: string;
  readonly totalRuns: number;
  readonly successfulRuns: number;
  readonly failedRuns: number;
  readonly otherRuns: number;
  readonly passRate: number;
  readonly meanDurationSeconds: number;
  readonly medianDurationSeconds: number;
  readonly p95DurationSeconds: number;
}

export interface FailureDetail {
  readonly workflow: string;
  readonly runId: number;
  readonly runNumber?: number | undefined;
  readonly commitSha: string;
  readonly commitMessage: string;
  readonly author: string;
  readonly htmlUrl: string;
  readonly failedAt: string;
  readonly durationSeconds: number;
}

export interface PipelineHealthReport {
  readonly generatedAt: string;
  readonly windowDays: number;
  readonly totalRuns: number;
  readonly completedRuns: number;
  readonly successfulRuns: number;
  readonly failedRuns: number;
  readonly otherRuns: number;
  readonly overallPassRate: number;
  readonly overallMeanDurationSeconds: number;
  readonly overallMedianDurationSeconds: number;
  readonly workflows: Record<string, WorkflowMetrics>;
  readonly recentFailures: readonly FailureDetail[];
}

export interface AggregationOptions {
  readonly windowDays?: number | undefined;
  readonly now?: Date | undefined;
  readonly branch?: string | undefined;
}

/**
 * Calculates duration of a workflow run in seconds.
 */
export function calculateDurationSeconds(run: WorkflowRun): number {
  const start = new Date(run.run_started_at || run.created_at).getTime();
  const end = new Date(run.updated_at).getTime();
  if (isNaN(start) || isNaN(end) || end < start) {
    return 0;
  }
  return Math.max(0, Math.round((end - start) / 1000));
}

/**
 * Helper to compute percentile from a sorted array of numbers.
 */
function calculatePercentile(sortedValues: readonly number[], percentile: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.ceil((percentile / 100) * sortedValues.length) - 1;
  const boundedIndex = Math.max(0, Math.min(index, sortedValues.length - 1));
  return sortedValues[boundedIndex] ?? 0;
}

/**
 * Aggregates workflow run metrics over a specified window (default 30 days).
 */
export function aggregatePipelineMetrics(
  runs: readonly WorkflowRun[],
  options: AggregationOptions = {},
): PipelineHealthReport {
  const windowDays = options.windowDays ?? 30;
  const now = options.now ?? new Date();
  const cutoffTime = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
  const targetBranch = options.branch;

  // Filter runs by window and optionally by branch
  const windowRuns = runs.filter((run) => {
    const runTime = new Date(run.created_at).getTime();
    if (isNaN(runTime) || runTime < cutoffTime) {
      return false;
    }
    if (targetBranch && run.head_branch !== targetBranch) {
      return false;
    }
    return true;
  });

  const completedRuns = windowRuns.filter((run) => run.status === "completed");
  const successfulRuns = completedRuns.filter((run) => run.conclusion === "success");
  const failedRuns = completedRuns.filter((run) => run.conclusion === "failure");
  const otherRuns = completedRuns.filter(
    (run) => run.conclusion !== "success" && run.conclusion !== "failure",
  );

  const decisiveRunsCount = successfulRuns.length + failedRuns.length;
  const overallPassRate =
    decisiveRunsCount > 0
      ? Math.round((successfulRuns.length / decisiveRunsCount) * 1000) / 10
      : 100.0;

  const durations = completedRuns.map(calculateDurationSeconds).sort((a, b) => a - b);

  const totalDuration = durations.reduce((acc, d) => acc + d, 0);
  const overallMeanDurationSeconds =
    durations.length > 0 ? Math.round(totalDuration / durations.length) : 0;
  const overallMedianDurationSeconds = calculatePercentile(durations, 50);

  // Group by workflow name
  const workflowGroups = new Map<string, WorkflowRun[]>();
  for (const run of windowRuns) {
    const list = workflowGroups.get(run.name) ?? [];
    list.push(run);
    workflowGroups.set(run.name, list);
  }

  const workflows: Record<string, WorkflowMetrics> = {};
  for (const [name, group] of workflowGroups.entries()) {
    const groupCompleted = group.filter((r) => r.status === "completed");
    const groupSuccess = groupCompleted.filter((r) => r.conclusion === "success");
    const groupFailure = groupCompleted.filter((r) => r.conclusion === "failure");
    const groupOther = groupCompleted.filter(
      (r) => r.conclusion !== "success" && r.conclusion !== "failure",
    );

    const groupDecisive = groupSuccess.length + groupFailure.length;
    const passRate =
      groupDecisive > 0 ? Math.round((groupSuccess.length / groupDecisive) * 1000) / 10 : 100.0;

    const groupDurations = groupCompleted.map(calculateDurationSeconds).sort((a, b) => a - b);
    const sumDuration = groupDurations.reduce((acc, d) => acc + d, 0);
    const mean = groupDurations.length > 0 ? Math.round(sumDuration / groupDurations.length) : 0;
    const median = calculatePercentile(groupDurations, 50);
    const p95 = calculatePercentile(groupDurations, 95);

    workflows[name] = {
      name,
      totalRuns: group.length,
      successfulRuns: groupSuccess.length,
      failedRuns: groupFailure.length,
      otherRuns: groupOther.length,
      passRate,
      meanDurationSeconds: mean,
      medianDurationSeconds: median,
      p95DurationSeconds: p95,
    };
  }

  // Extract recent failures sorted by date desc
  const failureRuns = [...failedRuns].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  const recentFailures: FailureDetail[] = failureRuns.slice(0, 15).map((run) => {
    const message = run.head_commit?.message?.split("\n")[0] || "No commit message";
    const author = run.head_commit?.author?.name || run.actor?.login || "unknown";
    return {
      workflow: run.name,
      runId: run.id,
      runNumber: run.run_number,
      commitSha: run.head_sha.slice(0, 7),
      commitMessage: message,
      author,
      htmlUrl: run.html_url,
      failedAt: run.created_at,
      durationSeconds: calculateDurationSeconds(run),
    };
  });

  return {
    generatedAt: now.toISOString(),
    windowDays,
    totalRuns: windowRuns.length,
    completedRuns: completedRuns.length,
    successfulRuns: successfulRuns.length,
    failedRuns: failedRuns.length,
    otherRuns: otherRuns.length,
    overallPassRate,
    overallMeanDurationSeconds,
    overallMedianDurationSeconds,
    workflows,
    recentFailures,
  };
}

/**
 * Formats a duration in seconds to a human-readable string (e.g. 2m 14s).
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

/**
 * Renders the pipeline health report into a GitHub-flavored Markdown dashboard.
 */
export function renderDashboardMarkdown(report: PipelineHealthReport): string {
  const healthBadge =
    report.overallPassRate >= 95
      ? "PASSING"
      : report.overallPassRate >= 90
        ? "DEGRADED"
        : "FAILING";

  let md = `# CI/CD Pipeline Health Dashboard\n\n`;
  md += `> Automatically generated on ${report.generatedAt} covering the last ${report.windowDays} days of workflow execution history.\n\n`;

  md += `## Pipeline Health Overview\n\n`;
  md += `| Metric | Value | Status |\n`;
  md += `| :--- | :--- | :--- |\n`;
  md += `| **Overall Pass Rate** | **${report.overallPassRate}%** | ${healthBadge} |\n`;
  md += `| **Total Executions** | ${report.totalRuns} runs (${report.completedRuns} completed) | Recorded |\n`;
  md += `| **Successful Runs** | ${report.successfulRuns} | Clean |\n`;
  md += `| **Failed Runs** | ${report.failedRuns} | Alert |\n`;
  md += `| **Mean Pipeline Duration** | ${formatDuration(report.overallMeanDurationSeconds)} | Average |\n`;
  md += `| **Median Pipeline Duration** | ${formatDuration(report.overallMedianDurationSeconds)} | p50 |\n\n`;

  md += `## Per-Workflow Performance Breakdown\n\n`;
  md += `| Workflow | Total Runs | Pass Rate | Mean Duration | Median Duration | P95 Duration | Status |\n`;
  md += `| :--- | :---: | :---: | :---: | :---: | :---: | :---: |\n`;

  const workflowList = Object.values(report.workflows).sort((a, b) => b.totalRuns - a.totalRuns);

  if (workflowList.length === 0) {
    md += `| _No workflows recorded_ | - | - | - | - | - | - |\n`;
  } else {
    for (const wf of workflowList) {
      const status = wf.passRate >= 95 ? "HEALTHY" : wf.passRate >= 90 ? "WARNING" : "CRITICAL";
      md += `| **${wf.name}** | ${wf.totalRuns} | ${wf.passRate}% | ${formatDuration(wf.meanDurationSeconds)} | ${formatDuration(wf.medianDurationSeconds)} | ${formatDuration(wf.p95DurationSeconds)} | ${status} |\n`;
    }
  }

  md += `\n## Recent Failures\n\n`;
  if (report.recentFailures.length === 0) {
    md += `_No pipeline failures recorded in the last ${report.windowDays} days._\n`;
  } else {
    md += `| Workflow | Commit | Author | Message | Duration | Logs |\n`;
    md += `| :--- | :--- | :--- | :--- | :--- | :--- |\n`;
    for (const fail of report.recentFailures) {
      const runLabel = fail.runNumber ? `#${fail.runNumber}` : `View`;
      md += `| **${fail.workflow}** | \`${fail.commitSha}\` | ${fail.author} | ${fail.commitMessage.replace(/\|/g, "\\|")} | ${formatDuration(fail.durationSeconds)} | [${runLabel}](${fail.htmlUrl}) |\n`;
    }
  }

  return md;
}

/**
 * Main generator entry point.
 */
export async function generateDashboard(
  runs: readonly WorkflowRun[],
  outputPath?: string,
): Promise<PipelineHealthReport> {
  const report = aggregatePipelineMetrics(runs, { windowDays: 30 });
  const markdown = renderDashboardMarkdown(report);

  if (outputPath) {
    await fs.writeFile(outputPath, markdown, "utf-8");
  }

  return report;
}

// CLI execution path
const scriptPath = process.argv[1] ?? "";
if (
  scriptPath.endsWith("generate.ts") ||
  scriptPath.endsWith("generate.js") ||
  scriptPath.endsWith("generate.mjs")
) {
  const runsFile = process.env.RUNS_FILE;
  const outputFile = process.env.OUTPUT_FILE || "ci-dashboard.md";

  (async () => {
    try {
      let runs: WorkflowRun[] = [];
      if (runsFile) {
        const content = await fs.readFile(runsFile, "utf-8");
        runs = JSON.parse(content);
      } else {
        console.log("No RUNS_FILE specified, generating empty template dashboard.");
      }
      const report = await generateDashboard(runs, outputFile);
      console.log(`Pipeline health dashboard written to ${outputFile}`);
      console.log(`Overall Pass Rate: ${report.overallPassRate}% across ${report.totalRuns} runs`);
    } catch (err) {
      console.error("Failed to generate CI dashboard:", err);
      process.exit(1);
    }
  })();
}
