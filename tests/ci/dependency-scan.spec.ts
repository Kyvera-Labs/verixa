/**
 * Dependency-scanning gate (Issue 207).
 *
 * The deliverable is a command a workflow runs, so every case here spawns it
 * and asserts on the exit code *and* the message. A gate whose failure nobody
 * can interpret gets bypassed, and the message is also the only place the
 * exception process is visible when it fires.
 *
 * The audit reports are captured fixtures rather than live `pnpm audit` output:
 * a test that reaches the npm registry fails when the network does, and reports
 * on vulnerabilities published since it was written instead of on the
 * behaviour under test. The fixture package manifest in the same directory is
 * the intentionally vulnerable dependency the report describes.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { REPO_ROOT, dependencyScanFixture, runDependencyScan } from "./helpers/ci-tooling.js";

const TODAY = "2026-10-17";

const scratch = mkdtempSync(join(tmpdir(), "verixa-dependency-scan-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

let exceptionCounter = 0;

/** Writes an exceptions document and returns the path the gate should read. */
function exceptionsFile(entries: readonly unknown[]): string {
  exceptionCounter += 1;
  const path = join(scratch, `exceptions-${exceptionCounter}.json`);
  writeFileSync(path, JSON.stringify({ exceptions: entries }, null, 2), "utf8");
  return path;
}

function scan(auditFixture: string, exceptionsPath?: string) {
  const args = ["--audit", dependencyScanFixture(auditFixture), "--today", TODAY];
  if (exceptionsPath !== undefined) {
    args.push("--exceptions", exceptionsPath);
  }
  return runDependencyScan(args);
}

const minimistException = {
  advisory: "GHSA-vh95-rmgr-6w4m",
  package: "minimist",
  justification: "Prototype pollution; the vulnerable path is not reachable in this deployment.",
  reviewedOn: "2026-10-01",
  expiresOn: "2026-12-31",
};

const lodashException = {
  advisory: "GHSA-35jh-r3h4-6jhm",
  package: "lodash",
  justification: "Fix not yet released for the pinned major; tracked upstream.",
  reviewedOn: "2026-10-01",
  expiresOn: "2026-12-31",
};

describe("dependency-scan gate", () => {
  it("fails on unexcepted high and critical advisories and names them", () => {
    const result = scan("vulnerable-audit.json");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("minimist");
    expect(result.stderr).toContain("GHSA-vh95-rmgr-6w4m");
    expect(result.stderr).toContain("lodash");
    expect(result.stderr).toContain("GHSA-35jh-r3h4-6jhm");
    // The npm registry id is the only identifier available when GitHub has not
    // published a GHSA, so it has to be reported too.
    expect(result.stderr).toContain("npm:1095808");
    expect(result.stderr).toContain("no matching entry");
  });

  it("does not fail on moderate findings", () => {
    // A gate that fails on every advisory is noise, and noise is routed
    // around. The acceptance criterion is high and critical in production.
    const result = scan("moderate-only-audit.json");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no high or critical advisories");
  });

  it("passes when every serious finding has an unexpired exception", () => {
    const result = scan(
      "vulnerable-audit.json",
      exceptionsFile([minimistException, lodashException]),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("covered by unexpired exceptions");
  });

  it("treats an expired exception as absent", () => {
    // Expiry is the whole point of the review date: if a stale exception kept
    // working, the date would be decorative.
    const result = scan(
      "vulnerable-audit.json",
      exceptionsFile([
        { ...minimistException, reviewedOn: "2025-10-01", expiresOn: "2026-01-01" },
        lodashException,
      ]),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("expired on 2026-01-01");
    expect(result.stderr).toContain("minimist");
    expect(result.stderr).not.toContain("lodash");
  });

  it("honours an exception that expires today, not before", () => {
    const result = scan(
      "vulnerable-audit.json",
      exceptionsFile([
        { ...minimistException, expiresOn: TODAY },
        { ...lodashException, expiresOn: TODAY },
      ]),
    );

    expect(result.exitCode).toBe(0);
  });

  it("does not let an exception for one advisory cover another in the same package", () => {
    const result = scan(
      "vulnerable-audit.json",
      exceptionsFile([{ ...minimistException, advisory: "GHSA-0000-0000-0000" }, lodashException]),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("GHSA-vh95-rmgr-6w4m");
  });

  it("reads the older advisories-map report shape as well", () => {
    const failing = scan("advisories-format-audit.json");
    expect(failing.exitCode).toBe(1);
    expect(failing.stderr).toContain("GHSA-vh95-rmgr-6w4m");
    expect(failing.stderr).toContain("CVE-2021-44906");

    const passing = scan("advisories-format-audit.json", exceptionsFile([minimistException]));
    expect(passing.exitCode).toBe(0);
  });

  it("exits 2, not 1, when the exceptions file is malformed", () => {
    // The split matters: a typo in the exceptions file must not be reported as
    // a vulnerability, and a vulnerability must not be mistaken for a typo.
    const result = scan(
      "vulnerable-audit.json",
      exceptionsFile([{ ...minimistException, justification: "" }, lodashException]),
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("justification");
  });

  it("exits 2 when the report is not an audit report", () => {
    const result = scan("unrecognized-audit.json");

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("vulnerabilities");
  });

  it("exits 2 when the audit report is missing", () => {
    const result = runDependencyScan(["--audit", join(scratch, "missing.json")]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("could not be read");
  });

  it("exits 2 for a usage error rather than passing", () => {
    const result = runDependencyScan([]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--audit is required");
  });

  it("fails against the repository's own, currently empty, exceptions file", () => {
    // Proves the maintained file is what the gate reads, not a fixture: an
    // empty exceptions file means every serious fixture finding fails.
    const result = runDependencyScan([
      "--audit",
      dependencyScanFixture("vulnerable-audit.json"),
      "--exceptions",
      join(REPO_ROOT, "infra", "ci", "security-exceptions.json"),
      "--today",
      TODAY,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no matching entry");
  });
});

describe("dependency-scan fixtures and workflow", () => {
  it("pins intentionally vulnerable production dependencies", () => {
    const manifest = JSON.parse(readFileSync(dependencyScanFixture("package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };

    // The report is only meaningful next to the manifest it describes. These
    // versions are the ones the fixtures' advisories name.
    expect(manifest.dependencies["minimist"]).toBe("1.2.0");
    expect(manifest.dependencies["lodash"]).toBe("4.17.15");
  });

  it("wires the gate to run on pull requests and on a nightly schedule", () => {
    const workflow = readFileSync(
      join(REPO_ROOT, ".github", "workflows", "dependency-scan.yml"),
      "utf8",
    );

    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("schedule:");
    expect(workflow).toContain("pnpm audit --prod --json");
    expect(workflow).toContain("infra/ci/dependency-scan.mjs");
    expect(workflow).toContain("infra/ci/security-exceptions.json");
  });
});
