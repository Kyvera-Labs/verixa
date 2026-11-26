#!/usr/bin/env node
/**
 * Pull-request change scan: the second half of the "Malware scan" check.
 *
 * check-malware-indicators.mjs looks for the known signs of one campaign
 * (PolinRider) anywhere in the tree. This script looks only at what a pull
 * request changes, for shapes that malicious contributions use in general and
 * that ordinary code in this repository never needs:
 *
 * - an added executable or script for another platform (.exe, .bat, .ps1...);
 * - an added line that decodes and runs a payload (eval of an atob or
 *   Buffer.from result, the Function constructor, long fromCharCode lists);
 * - an added line holding a long base64 or hex-escape blob;
 * - an added line that pipes a download into a shell;
 * - any change to the malware scanners or the workflow that runs them.
 *
 * Only added lines are read, so existing files cannot trigger it and a
 * finding always points at the change that introduced it. A finding is not a
 * verdict: some are legitimate, so a maintainer who has read the change can
 * clear them by adding the `security-reviewed` label, which the workflow
 * passes in as SECURITY_REVIEWED=1. Pull request authors without write
 * access cannot add labels.
 *
 * Like the tripwire it is plain JavaScript with no dependencies, and the
 * workflow runs main's copy of it against the pull request's files, so a pull
 * request cannot change the rules it is checked against.
 *
 * Usage: node infra/ci/check-pr-changes.mjs --repo <dir> --base <commit> [--head <commit>]
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const EXECUTABLE_EXTENSIONS = new Set([
  ".exe",
  ".dll",
  ".com",
  ".scr",
  ".msi",
  ".bat",
  ".cmd",
  ".ps1",
  ".psm1",
  ".vbs",
  ".vbe",
  ".wsf",
  ".hta",
  ".jar",
  ".so",
  ".dylib",
]);

// Changing any of these changes what this check enforces.
const SCANNER_PATHS = new Set([
  "infra/ci/check-malware-indicators.mjs",
  "infra/ci/check-pr-changes.mjs",
  ".github/workflows/malware-scan.yml",
  ".github/workflows/pr-malware-sweep.yml",
]);

// Lines in these are data, not code, and legitimately hold long hashes.
const LINE_CHECK_EXEMPT = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$|\.(md|svg|snap)$/;

// Built with RegExp and fragments so this file's own source does not match.
const LINE_RULES = [
  {
    name: "decodes and evaluates a payload",
    pattern: new RegExp(
      ["\\be", "val\\s*\\(\\s*(atob|Buffer\\.from|unescape|decodeURIComponent)\\s*\\("].join(""),
    ),
  },
  {
    name: "builds code from a string (new Function)",
    pattern: new RegExp(["\\bnew\\s+Func", "tion\\s*\\("].join("")),
  },
  {
    name: "long String.fromCharCode sequence",
    pattern: new RegExp(["String\\.fromChar", "Code\\s*\\(\\s*(\\d+\\s*,\\s*){15,}"].join("")),
  },
  {
    name: "long base64 blob",
    pattern: new RegExp(["[A-Za-z0-9+/]", "{400,}={0,2}"].join("")),
  },
  {
    name: "long hex-escape blob",
    pattern: new RegExp(["(\\\\x[0-9a-fA-F]", "{2}){40,}"].join("")),
  },
  {
    name: "pipes a download into a shell",
    pattern: new RegExp(
      ["\\b(cu", "rl|wg", "et)\\b[^|\\n]*\\|\\s*(sudo\\s+)?(ba|z)?sh\\b"].join(""),
      "i",
    ),
  },
  {
    name: "pipes a download into PowerShell",
    pattern: new RegExp(
      [
        "\\b(i",
        "wr|Invoke-Web",
        "Request)\\b[^\\n]*\\|\\s*(i",
        "ex|Invoke-Exp",
        "ression)\\b",
      ].join(""),
      "i",
    ),
  },
];

function git(repoRoot, args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** Files the change adds or modifies, with git's status letter. */
function changedFiles(repoRoot, base, head) {
  const output = git(repoRoot, ["diff", "--name-status", "-z", "--no-renames", base, head]);
  const parts = output.split("\0").filter((part) => part.length > 0);
  const files = [];
  for (let index = 0; index + 1 < parts.length; index += 2) {
    files.push({ status: parts[index], file: parts[index + 1] });
  }
  return files;
}

/** Lines the change adds to `file`, with their new line numbers. */
function addedLines(repoRoot, base, head, file) {
  const diff = git(repoRoot, [
    "diff",
    "-U0",
    "--no-color",
    "--no-ext-diff",
    base,
    head,
    "--",
    file,
  ]);
  const lines = [];
  let lineNumber = 0;
  for (const line of diff.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      lineNumber = Number(hunk[1]);
      continue;
    }
    if (line.startsWith("+++")) continue;
    if (line.startsWith("+")) {
      lines.push({ number: lineNumber, text: line.slice(1) });
      lineNumber += 1;
    }
  }
  return lines;
}

export function scanChanges(repoRoot, base, head = "HEAD") {
  const findings = [];
  for (const { status, file } of changedFiles(repoRoot, base, head)) {
    if (status === "D") continue;
    if (SCANNER_PATHS.has(file)) {
      findings.push(`${file}: changes the malware scanners themselves`);
    }
    const extension = path.posix.extname(file).toLowerCase();
    if (status === "A" && EXECUTABLE_EXTENSIONS.has(extension)) {
      findings.push(`${file}: adds an executable or script file (${extension})`);
      continue;
    }
    if (LINE_CHECK_EXEMPT.test(file)) continue;
    for (const { number, text } of addedLines(repoRoot, base, head, file)) {
      for (const rule of LINE_RULES) {
        if (rule.pattern.test(text)) findings.push(`${file}:${number}: ${rule.name}`);
      }
    }
  }
  return findings;
}

function cliFlag(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 || index + 1 >= argv.length ? undefined : argv[index + 1];
}

// Run only when executed directly, so tests can import scanChanges.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const repoRoot = path.resolve(cliFlag(argv, "--repo") ?? process.cwd());
  const base = cliFlag(argv, "--base");
  if (base === undefined) {
    process.stderr.write(
      "usage: check-pr-changes.mjs --repo <dir> --base <commit> [--head <commit>]\n",
    );
    process.exit(2);
  }
  const findings = scanChanges(repoRoot, base, cliFlag(argv, "--head") ?? "HEAD");
  const reviewed = process.env["SECURITY_REVIEWED"] === "1";

  if (findings.length === 0) {
    process.stdout.write("pr changes: ok — nothing in this change needs a security review\n");
  } else if (reviewed) {
    for (const finding of findings) process.stdout.write(`pr changes (reviewed): ${finding}\n`);
    process.stdout.write(
      `\npr changes: ${findings.length} finding(s), cleared by the security-reviewed label.\n`,
    );
  } else {
    for (const finding of findings) process.stderr.write(`pr changes: ${finding}\n`);
    process.stderr.write(
      `\npr changes: ${findings.length} finding(s). A maintainer must read these changes ` +
        "and add the security-reviewed label before this can merge.\n",
    );
    process.exitCode = 1;
  }
}
