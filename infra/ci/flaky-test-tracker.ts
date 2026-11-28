import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type TestFlakeClassification = "stable" | "flaky" | "failing";

export interface TestExecutionAttempt {
  attempt: number;
  passed: boolean;
  durationMs?: number | undefined;
  error?: string | undefined;
}

export interface TestClassificationResult {
  testId: string;
  classification: TestFlakeClassification;
  attempts: TestExecutionAttempt[];
  passed: boolean;
  message: string;
}

export interface QuarantineMetadata {
  testId: string;
  until: string; // ISO date YYYY-MM-DD
  reason: string;
  issue?: string | undefined;
  owner?: string | undefined;
}

export type QuarantineStatus = "active" | "expired" | "invalid";

export interface QuarantineEvaluation {
  metadata: QuarantineMetadata;
  status: QuarantineStatus;
  isExpired: boolean;
  daysRemainingOrOverdue: number;
  shouldSkip: boolean;
  diagnostic: string;
}

export interface FlakyRecord {
  testId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  flakinessCount: number;
  status: "open" | "quarantined" | "resolved";
  issueUrl?: string | undefined;
  recentAttempts?: TestExecutionAttempt[] | undefined;
}

export interface FlakyLedger {
  version: number;
  updatedAt: string;
  tests: Record<string, FlakyRecord>;
}

export interface FlakyCliOptions {
  reportPath?: string | undefined;
  ledgerPath?: string | undefined;
  markdownPath?: string | undefined;
  scanQuarantines?: boolean | undefined;
  maxRetries?: number | undefined;
}

/**
 * Classifies a test execution based on its attempt sequence.
 *
 * Distinguishes:
 * - "stable": Passed on first attempt
 * - "flaky": Failed on first attempt, but passed on a subsequent retry within maxRetries
 * - "failing": Failed on every attempt up to maxRetries
 */
export function classifyTestExecution(
  testId: string,
  attempts: TestExecutionAttempt[],
  maxRetries = 3,
): TestClassificationResult {
  if (attempts.length === 0) {
    return {
      testId,
      classification: "failing",
      attempts,
      passed: false,
      message: "No execution attempts recorded for test.",
    };
  }

  const firstAttempt = attempts[0]!;
  if (firstAttempt.passed) {
    return {
      testId,
      classification: "stable",
      attempts,
      passed: true,
      message: "Test passed cleanly on initial attempt.",
    };
  }

  // Attempt 1 failed. Check if any subsequent retry passed
  const allowedAttempts = attempts.slice(0, 1 + maxRetries);
  const passedRetry = allowedAttempts.find((att) => att.attempt > 1 && att.passed);

  if (passedRetry) {
    return {
      testId,
      classification: "flaky",
      attempts,
      passed: true,
      message: `Test is FLAKY. Failed on attempt 1, but passed on retry ${passedRetry.attempt} (within max retries of ${maxRetries}).`,
    };
  }

  return {
    testId,
    classification: "failing",
    attempts,
    passed: false,
    message: `Test consistently failed across all ${attempts.length} attempt(s).`,
  };
}

/**
 * Parses `@quarantine(...)` tag from a test title, docstring, or comment.
 *
 * Format:
 * `@quarantine(until=YYYY-MM-DD, reason="...", issue="#123", owner="@dev")`
 */
export function parseQuarantineTag(
  text: string,
  defaultTestId = "unknown",
): QuarantineMetadata | null {
  const match = /@quarantine\(([^)]+)\)/.exec(text);
  if (!match || !match[1]) {
    return null;
  }

  // Normalize escaped quotes from string literals
  const body = match[1].replace(/\\"/g, '"').replace(/\\'/g, "'");
  const params: Record<string, string> = {};

  const paramRegex = /([a-zA-Z_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^,\s)]+))/g;
  let paramMatch: RegExpExecArray | null;
  while ((paramMatch = paramRegex.exec(body)) !== null) {
    const key = paramMatch[1]!.toLowerCase();
    const val = paramMatch[2] ?? paramMatch[3] ?? paramMatch[4] ?? "";
    params[key] = val;
  }

  const until = params["until"];
  const reason = params["reason"] ?? "No reason provided";

  if (!until) {
    return null;
  }

  const meta: QuarantineMetadata = {
    testId: defaultTestId,
    until,
    reason,
  };

  if (params["issue"] !== undefined) {
    meta.issue = params["issue"];
  }

  if (params["owner"] !== undefined) {
    meta.owner = params["owner"];
  }

  return meta;
}

/**
 * Evaluates whether a quarantine tag is active, expired, or invalid against a reference date.
 */
export function evaluateQuarantine(
  metadata: QuarantineMetadata,
  referenceDate: Date = new Date(),
): QuarantineEvaluation {
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(metadata.until)) {
    return {
      metadata,
      status: "invalid",
      isExpired: false,
      daysRemainingOrOverdue: 0,
      shouldSkip: false,
      diagnostic: `Invalid quarantine expiration date format: '${metadata.until}'. Expected 'YYYY-MM-DD'.`,
    };
  }

  const untilParts = metadata.until.split("-").map((p) => parseInt(p, 10));
  const untilMidnight = Date.UTC(untilParts[0] ?? 0, (untilParts[1] ?? 1) - 1, untilParts[2] ?? 1);
  const refMidnight = Date.UTC(
    referenceDate.getUTCFullYear(),
    referenceDate.getUTCMonth(),
    referenceDate.getUTCDate(),
  );

  const daysDiff = Math.round((untilMidnight - refMidnight) / (1000 * 60 * 60 * 24));

  if (daysDiff < 0) {
    const overdueDays = Math.abs(daysDiff);
    return {
      metadata,
      status: "expired",
      isExpired: true,
      daysRemainingOrOverdue: overdueDays,
      shouldSkip: false, // Quarantine expired: Must re-fail and cannot be skipped!
      diagnostic: `Quarantine EXPIRED ${overdueDays} day(s) ago on ${metadata.until}. Test re-activated and must be addressed. Reason: "${metadata.reason}" (Issue: ${metadata.issue ?? "none"}).`,
    };
  }

  return {
    metadata,
    status: "active",
    isExpired: false,
    daysRemainingOrOverdue: daysDiff,
    shouldSkip: true, // Active quarantine: Safe to skip temporarily
    diagnostic: `Quarantine ACTIVE (${daysDiff} day(s) remaining until ${metadata.until}). Skipping test. Reason: "${metadata.reason}" (Issue: ${metadata.issue ?? "none"}).`,
  };
}

/**
 * Updates the flaky tests ledger with a newly observed test outcome.
 */
export function recordFlakyTest(
  ledger: FlakyLedger,
  testId: string,
  attempts: TestExecutionAttempt[],
  now: Date = new Date(),
): FlakyRecord {
  const existing = ledger.tests[testId];
  const nowIso = now.toISOString();

  if (existing) {
    existing.lastSeenAt = nowIso;
    existing.flakinessCount += 1;
    existing.recentAttempts = attempts;
    return existing;
  }

  const newRecord: FlakyRecord = {
    testId,
    firstSeenAt: nowIso,
    lastSeenAt: nowIso,
    flakinessCount: 1,
    status: "open",
    recentAttempts: attempts,
  };

  ledger.tests[testId] = newRecord;
  return newRecord;
}

/**
 * Formats flaky test and quarantine status into a GitHub Flavored Markdown summary.
 */
export function formatFlakyReportMarkdown(
  classifications: TestClassificationResult[],
  quarantines: QuarantineEvaluation[],
): string {
  const lines: string[] = [];
  lines.push("## Flaky Test & Quarantine Report (Issue 414)");
  lines.push("");

  const flakyTests = classifications.filter((c) => c.classification === "flaky");
  const failingTests = classifications.filter((c) => c.classification === "failing");
  const expiredQuarantines = quarantines.filter((q) => q.status === "expired");

  if (flakyTests.length === 0 && failingTests.length === 0 && expiredQuarantines.length === 0) {
    lines.push(
      "**No flaky tests or expired quarantines detected.** Test suite execution was stable.",
    );
  } else {
    lines.push("**Test stability anomalies detected.** Review the tables below for details.");
  }

  lines.push("");

  // Flaky tests section
  if (flakyTests.length > 0) {
    lines.push(`### Flaky Tests (${flakyTests.length})`);
    lines.push("");
    lines.push("These tests failed on initial execution but succeeded on subsequent retries:");
    lines.push("");
    lines.push("| Test Identifier | Total Attempts | Successful Retry | Details |");
    lines.push("| :--- | :---: | :---: | :--- |");

    for (const test of flakyTests) {
      const passAttempt = test.attempts.find((a) => a.attempt > 1 && a.passed);
      const passedOn = passAttempt ? `Attempt ${passAttempt.attempt}` : "Unknown";
      lines.push(
        `| \`${test.testId}\` | ${test.attempts.length} | ${passedOn} | ${test.message} |`,
      );
    }
    lines.push("");
  }

  // Quarantined tests section
  if (quarantines.length > 0) {
    lines.push(`### Quarantined Tests (${quarantines.length})`);
    lines.push("");
    lines.push("| Test Identifier | Expiration Date | Status | Issue | Reason |");
    lines.push("| :--- | :---: | :---: | :---: | :--- |");

    for (const q of quarantines) {
      const statusBadge =
        q.status === "expired"
          ? `EXPIRED (${q.daysRemainingOrOverdue}d overdue)`
          : `Active (${q.daysRemainingOrOverdue}d left)`;
      lines.push(
        `| \`${q.metadata.testId}\` | \`${q.metadata.until}\` | ${statusBadge} | ${q.metadata.issue ?? "-"} | ${q.metadata.reason} |`,
      );
    }
    lines.push("");
  }

  // Expired quarantine alerts
  if (expiredQuarantines.length > 0) {
    lines.push("### Expired Quarantines Alert");
    lines.push("");
    lines.push(
      "The following tests have reached their quarantine expiration deadline and **cannot remain skipped**:",
    );
    for (const eq of expiredQuarantines) {
      lines.push(
        `- **\`${eq.metadata.testId}\`** expired on **${eq.metadata.until}** (${eq.diagnostic})`,
      );
    }
    lines.push("");
    lines.push(
      "> **Action Required:** Fix the root cause or formally extend the quarantine with an updated tracking issue.",
    );
    lines.push("");
  }

  // Consistently failing tests
  if (failingTests.length > 0) {
    lines.push(`### Failing Tests (${failingTests.length})`);
    lines.push("");
    for (const ft of failingTests) {
      lines.push(`- **\`${ft.testId}\`**: ${ft.message}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Recursively scans directory for test files containing @quarantine tags.
 */
export function scanDirectoryForQuarantines(
  dir: string,
  referenceDate: Date = new Date(),
): QuarantineEvaluation[] {
  const evaluations: QuarantineEvaluation[] = [];

  function walk(currentDir: string): void {
    if (!existsSync(currentDir)) return;
    const entries = readdirSync(currentDir);
    for (const entry of entries) {
      if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
      const fullPath = join(currentDir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (
        entry.endsWith(".test.ts") ||
        entry.endsWith(".spec.ts") ||
        entry.endsWith(".contract.test.ts")
      ) {
        const content = readFileSync(fullPath, "utf-8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          if (line.includes("@quarantine")) {
            const meta = parseQuarantineTag(line, `${fullPath}#L${i + 1}`);
            if (meta) {
              evaluations.push(evaluateQuarantine(meta, referenceDate));
            }
          }
        }
      }
    }
  }

  walk(dir);
  return evaluations;
}

/**
 * Main execution runner for flaky test tracking and quarantine checks.
 */
export function runFlakyTracker(options: FlakyCliOptions = {}): number {
  const rootDir = process.cwd();
  const maxRetries = options.maxRetries ?? 3;
  const ledgerPath = resolve(rootDir, options.ledgerPath ?? "infra/ci/flaky-tests-ledger.json");
  const markdownPath = options.markdownPath ? resolve(rootDir, options.markdownPath) : undefined;

  let ledger: FlakyLedger = {
    version: 1,
    updatedAt: new Date().toISOString(),
    tests: {},
  };

  if (existsSync(ledgerPath)) {
    try {
      ledger = JSON.parse(readFileSync(ledgerPath, "utf-8")) as FlakyLedger;
    } catch {
      console.warn(`[flaky-tracker] Could not parse ledger at ${ledgerPath}, starting fresh.`);
    }
  }

  const classifications: TestClassificationResult[] = [];
  let quarantines: QuarantineEvaluation[] = [];

  // If scanQuarantines requested, audit all test directories
  if (options.scanQuarantines) {
    const packagesDir = resolve(rootDir, "packages");
    const testsDir = resolve(rootDir, "tests");
    quarantines = [
      ...scanDirectoryForQuarantines(packagesDir),
      ...scanDirectoryForQuarantines(testsDir),
    ];
  }

  if (options.reportPath) {
    const reportFile = resolve(rootDir, options.reportPath);
    if (existsSync(reportFile)) {
      try {
        const rawReport = JSON.parse(readFileSync(reportFile, "utf-8")) as {
          testResults?: { name: string; attempts: TestExecutionAttempt[] }[];
        };
        if (Array.isArray(rawReport.testResults)) {
          for (const item of rawReport.testResults) {
            const classified = classifyTestExecution(item.name, item.attempts, maxRetries);
            classifications.push(classified);
            if (classified.classification === "flaky") {
              recordFlakyTest(ledger, item.name, item.attempts);
            }
          }
        }
      } catch (e) {
        console.warn(`[flaky-tracker] Warning: Failed to parse test report at ${reportFile}:`, e);
      }
    }
  }

  const markdown = formatFlakyReportMarkdown(classifications, quarantines);
  console.log(markdown);

  if (markdownPath) {
    writeFileSync(markdownPath, markdown, "utf-8");
  }

  if (classifications.some((c) => c.classification === "flaky")) {
    ledger.updatedAt = new Date().toISOString();
    writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + "\n", "utf-8");
    console.log(`[flaky-tracker] Flaky tests recorded to ${ledgerPath}`);
  }

  const hasExpiredQuarantines = quarantines.some((q) => q.status === "expired");
  const hasFailingTests = classifications.some((c) => c.classification === "failing");

  if (hasExpiredQuarantines) {
    console.error("[flaky-tracker] Error: One or more quarantined tests have expired deadlines!");
    return 1;
  }

  if (hasFailingTests) {
    return 1;
  }

  return 0;
}

// Direct CLI invocation
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const cliOptions: FlakyCliOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--scan-quarantines") {
      cliOptions.scanQuarantines = true;
    } else if (arg === "--report" && args[i + 1]) {
      cliOptions.reportPath = args[++i];
    } else if (arg === "--ledger" && args[i + 1]) {
      cliOptions.ledgerPath = args[++i];
    } else if (arg === "--output-markdown" && args[i + 1]) {
      cliOptions.markdownPath = args[++i];
    } else if (arg === "--max-retries" && args[i + 1]) {
      cliOptions.maxRetries = parseInt(args[++i]!, 10);
    }
  }

  try {
    const exitCode = runFlakyTracker(cliOptions);
    process.exit(exitCode);
  } catch (err: unknown) {
    console.error("[flaky-tracker] Fatal error:", err);
    process.exit(1);
  }
}
