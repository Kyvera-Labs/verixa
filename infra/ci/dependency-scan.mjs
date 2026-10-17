/**
 * Dependency-scanning gate (issue 207).
 *
 * Reads a `pnpm audit --prod --json` report and fails when a high or critical
 * advisory affects a production dependency and is not covered by an unexpired
 * entry in `infra/ci/security-exceptions.json`.
 *
 * ## Why this exists as its own script rather than a shell one-liner in the
 * workflow
 *
 * `pnpm audit` already exits non-zero when it finds anything at or above the
 * audit level, so a gate could be `pnpm audit --audit-level=high`. That gate
 * cannot express the exception process: a maintainer who has reviewed an
 * advisory and decided a fix is not available yet has no way to say so except
 * to stop auditing. This script makes that decision explicit and dated, so it
 * comes up for review instead of living forever in a comment.
 *
 * It also has to be testable. The behaviour that matters is "which findings
 * fail", and a fixture report can exercise every branch of that in
 * milliseconds — including the two that matter most, an exception that covers
 * a finding and one that has expired.
 *
 * ## Usage
 *
 *   node infra/ci/dependency-scan.mjs \
 *     --audit dependency-audit.json \
 *     --exceptions infra/ci/security-exceptions.json \
 *     [--today 2026-10-17]
 *
 * Exit codes: 0 pass, 1 unexcepted or expired high/critical findings, 2 the
 * inputs are malformed. The split is deliberate: a misconfigured exceptions
 * file must not look like a vulnerability, and a vulnerability must not look
 * like a typo in the workflow.
 */

import { readFileSync } from "node:fs";

const FAILING_SEVERITIES = new Set(["high", "critical"]);
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** Advisory identifiers the exceptions file may name. */
const GHSA_SHAPE = /GHSA-[0-9A-Za-z]+(?:-[0-9A-Za-z]+)+/g;
const CVE_SHAPE = /CVE-\d{4}-\d{4,}/gi;

function usage(message) {
  return new Error(
    `${message}\nUsage: node infra/ci/dependency-scan.mjs ` +
      "--audit <audit.json> [--exceptions <exceptions.json>] [--today YYYY-MM-DD]",
  );
}

function parseArguments(argv) {
  const options = { audit: undefined, exceptions: undefined, today: undefined };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];

    if (value === undefined) {
      throw usage(`Missing value for ${flag}.`);
    }

    switch (flag) {
      case "--audit":
        options.audit = value;
        break;
      case "--exceptions":
        options.exceptions = value;
        break;
      case "--today":
        options.today = value;
        break;
      default:
        throw usage(`Unknown argument: ${flag}`);
    }

    index += 1;
  }

  if (options.audit === undefined) {
    throw usage("--audit is required.");
  }

  if (options.today !== undefined && !DATE_SHAPE.test(options.today)) {
    throw usage(`--today must be YYYY-MM-DD, got "${options.today}".`);
  }

  return options;
}

function readJson(path, description) {
  let text;

  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`${description} is unreadable: ${path} could not be read.`);
  }

  if (text.trim() === "") {
    throw new Error(`${description} is empty: ${path}.`);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${description} is not valid JSON: ${path} (${error.message}).`);
  }
}

/**
 * Advisory identifiers for one reported finding.
 *
 * `pnpm audit` and `npm audit` disagree about where the identifier lives
 * depending on version and on whether the advisory came from the npm registry
 * or GitHub. Rather than guess, every plausible field is mined and the union
 * kept, so an exceptions file can name whichever spelling it saw in the report.
 * The npm numeric `source` becomes `npm:<id>`, which is the only identifier
 * available when GitHub has not published a GHSA for the advisory.
 */
function advisoryIdentifiers(source) {
  const identifiers = new Set();
  const texts = [];

  if (typeof source === "string") {
    texts.push(source);
  } else if (source !== null && typeof source === "object") {
    for (const field of ["url", "title", "github_advisory_id", "cve", "id", "source"]) {
      const value = source[field];
      if (value !== undefined && value !== null) {
        texts.push(String(value));
      }
    }
    if (source.source !== undefined && /^\d+$/.test(String(source.source))) {
      identifiers.add(`npm:${String(source.source)}`);
    }
  }

  for (const text of texts) {
    // Kept in the casing the report used: identifiers are printed back to a
    // maintainer who then copies one into the exceptions file, so inventing a
    // casing here would mean the message and the file disagree. Comparison is
    // case-insensitive on both sides instead.
    for (const match of text.matchAll(GHSA_SHAPE)) {
      identifiers.add(match[0]);
    }
    for (const match of text.matchAll(CVE_SHAPE)) {
      identifiers.add(match[0]);
    }
  }

  return [...identifiers];
}

/** One `{ package, severity, identifiers, versions }` record per affected package. */
function findingsFromVulnerabilitiesMap(vulnerabilities) {
  const findings = [];

  for (const [packageName, entry] of Object.entries(vulnerabilities)) {
    if (entry === null || typeof entry !== "object") continue;

    const identifiers = new Set();
    for (const via of Array.isArray(entry.via) ? entry.via : []) {
      for (const identifier of advisoryIdentifiers(via)) {
        identifiers.add(identifier);
      }
    }

    const nodes = Array.isArray(entry.nodes) ? entry.nodes : [];
    findings.push({
      package: typeof entry.name === "string" ? entry.name : packageName,
      severity: typeof entry.severity === "string" ? entry.severity.toLowerCase() : "unknown",
      range: typeof entry.range === "string" ? entry.range : "",
      paths: nodes.filter((node) => typeof node === "string"),
      identifiers: [...identifiers],
    });
  }

  return findings;
}

/** The older `{ advisories: { id: {...} } }` shape, still emitted by some pnpm versions. */
function findingsFromAdvisoriesMap(advisories) {
  const findings = [];

  for (const entry of Object.values(advisories)) {
    if (entry === null || typeof entry !== "object") continue;

    const identifiers = new Set(advisoryIdentifiers(entry));
    if (entry.github_advisory_id !== undefined) {
      identifiers.add(String(entry.github_advisory_id));
    }
    if (entry.cve !== undefined) {
      identifiers.add(String(entry.cve));
    }

    const versions = Array.isArray(entry.findings)
      ? entry.findings.map((finding) => String(finding?.version ?? "")).filter(Boolean)
      : [];

    findings.push({
      package: String(entry.module_name ?? "unknown"),
      severity: typeof entry.severity === "string" ? entry.severity.toLowerCase() : "unknown",
      range: typeof entry.vulnerable_versions === "string" ? entry.vulnerable_versions : "",
      paths: versions,
      identifiers: [...identifiers],
    });
  }

  return findings;
}

function parseAuditReport(report) {
  if (report === null || typeof report !== "object") {
    throw new Error("The audit report is not a JSON object.");
  }

  if (report.auditReportVersion !== undefined && report.auditReportVersion !== 2) {
    throw new Error(
      `Unsupported auditReportVersion ${String(report.auditReportVersion)}; this gate reads version 2.`,
    );
  }

  if (report.vulnerabilities !== undefined && typeof report.vulnerabilities === "object") {
    return findingsFromVulnerabilitiesMap(report.vulnerabilities);
  }

  if (report.advisories !== undefined && typeof report.advisories === "object") {
    return findingsFromAdvisoriesMap(report.advisories);
  }

  throw new Error(
    'The audit report has neither a "vulnerabilities" nor an "advisories" object; ' +
      "it may not be an audit report at all.",
  );
}

function validateException(entry, index) {
  const problems = [];

  if (entry === null || typeof entry !== "object") {
    return [`exceptions[${index}] is not an object`];
  }

  for (const field of ["advisory", "package", "justification", "reviewedOn", "expiresOn"]) {
    if (typeof entry[field] !== "string" || entry[field].trim() === "") {
      problems.push(`exceptions[${index}].${field} must be a non-empty string`);
    }
  }

  for (const field of ["reviewedOn", "expiresOn"]) {
    const value = entry[field];
    if (typeof value === "string" && !DATE_SHAPE.test(value)) {
      problems.push(`exceptions[${index}].${field} must be YYYY-MM-DD`);
    }
  }

  if (
    typeof entry.reviewedOn === "string" &&
    typeof entry.expiresOn === "string" &&
    DATE_SHAPE.test(entry.reviewedOn) &&
    DATE_SHAPE.test(entry.expiresOn) &&
    entry.expiresOn < entry.reviewedOn
  ) {
    problems.push(`exceptions[${index}].expiresOn is before reviewedOn`);
  }

  return problems;
}

function loadExceptions(path, today) {
  if (path === undefined) {
    return [];
  }

  const document = readJson(path, "The exceptions file");
  const entries = Array.isArray(document) ? document : document.exceptions;

  if (!Array.isArray(entries)) {
    throw new Error(
      `${path} must be an array of exceptions or an object with an "exceptions" array.`,
    );
  }

  const problems = entries.flatMap(validateException);

  if (problems.length > 0) {
    throw new Error(
      `The exceptions file is malformed:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  }

  return entries.map((entry) => ({
    advisory: entry.advisory,
    package: entry.package,
    justification: entry.justification,
    reviewedOn: entry.reviewedOn,
    expiresOn: entry.expiresOn,
    expired: entry.expiresOn < today,
  }));
}

function exceptionFor(finding, exceptions) {
  return exceptions.find(
    (exception) =>
      exception.package.toLowerCase() === finding.package.toLowerCase() &&
      finding.identifiers.some(
        (identifier) => identifier.toUpperCase() === exception.advisory.toUpperCase(),
      ),
  );
}

function describeFinding(finding) {
  const identifiers = finding.identifiers.length > 0 ? finding.identifiers.join(", ") : "no id";
  const range = finding.range === "" ? "" : ` (${finding.range})`;
  return `${finding.package} [${finding.severity}]${range} ${identifiers}`;
}

function main(argv) {
  const options = parseArguments(argv);
  const today = options.today ?? new Date().toISOString().slice(0, 10);

  const report = readJson(options.audit, "The audit report");
  const findings = parseAuditReport(report);
  const exceptions = loadExceptions(options.exceptions, today);

  const serious = findings.filter((finding) => FAILING_SEVERITIES.has(finding.severity));
  const failures = [];
  const excepted = [];

  for (const finding of serious) {
    const exception = exceptionFor(finding, exceptions);

    // An expired exception is treated as absent: the point of expiry is to
    // force the finding back onto the failure list so it is re-reviewed, and a
    // gate that kept honouring it would make the date decorative.
    if (exception !== undefined && !exception.expired) {
      excepted.push({ finding, exception });
      continue;
    }

    failures.push({ finding, exception });
  }

  if (failures.length === 0) {
    if (serious.length === 0) {
      process.stdout.write(
        "dependency scan: no high or critical advisories in the audited dependencies.\n",
      );
    } else {
      process.stdout.write(
        `dependency scan: all ${serious.length} high/critical finding(s) are covered ` +
          "by unexpired exceptions.\n",
      );
    }
    return 0;
  }

  const lines = [
    `dependency scan: ${failures.length} unexcepted high/critical finding(s) ` +
      `of ${serious.length} total.`,
  ];

  for (const { finding, exception } of failures) {
    const reason =
      exception === undefined
        ? "no matching entry in the exceptions file"
        : `exception expired on ${exception.expiresOn}`;
    lines.push(`  - ${describeFinding(finding)} — ${reason}`);
  }

  if (excepted.length > 0) {
    lines.push(`  (${excepted.length} further finding(s) are excepted until their review date.)`);
  }

  lines.push(
    "Add a reviewed entry to the exceptions file with a justification and a review date, " +
      "or upgrade the dependency.",
  );

  process.stderr.write(`${lines.join("\n")}\n`);
  return 1;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  // Input problems exit 2 so a broken workflow is never mistaken for a
  // vulnerability, and never silently passes.
  process.stderr.write(`dependency scan: ${error.message}\n`);
  process.exitCode = 2;
}
