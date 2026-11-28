#!/usr/bin/env node
/**
 * Pushes rendered roadmap issues to GitHub.
 *
 *     node scripts/issues/push.mjs --dry-run
 *     node scripts/issues/push.mjs --limit 200
 *     node scripts/issues/push.mjs --from 081 --to 120
 *
 * Bulk-created issues are hard to undo, so:
 *
 * - Dry run is the default; creating requires `--execute`.
 * - Idempotent: existing issues are matched by their `[NNN]` title prefix and skipped.
 * - Entries marked `- [x]` in planning/ROADMAP.md are never created.
 * - A pause between creations stays under GitHub's secondary rate limits.
 * - State is written as it goes, so an interrupted run resumes and cross-links are filled in on
 *   later passes.
 */
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { byRoadmapId, loadRoadmap, REPO_ROOT } from "./roadmap.mjs";
import { labelsFor, renderIssueBody, renderIssueTitle } from "./render.mjs";

const REPO = "Kyvera-Labs/verixa";
const STATE_PATH = join(REPO_ROOT, "build", "issues", "pushed.json");

/** Pause between creations. Comfortably under GitHub's secondary limits. */
const DELAY_MS = 3000;

const LABEL_COLOURS = {
  "phase-01": "0E8A16",
  "phase-02": "0E8A16",
  "phase-03": "0E8A16",
  "phase-04": "0E8A16",
  "phase-05": "1D76DB",
  "phase-06": "1D76DB",
  "phase-07": "1D76DB",
  "phase-08": "1D76DB",
  "phase-09": "5319E7",
  "phase-10": "5319E7",
  "phase-11": "5319E7",
  "phase-12": "5319E7",
  "phase-13": "B60205",
  "phase-14": "B60205",
  "phase-15": "B60205",
  "phase-16": "B60205",
  "phase-17": "FBCA04",
  "phase-18": "FBCA04",
  "phase-19": "FBCA04",
  "phase-20": "FBCA04",
  "phase-21": "006B75",
  "phase-22": "006B75",
  "phase-23": "006B75",
  "phase-24": "006B75",
  "phase-25": "006B75",
  domain: "1D76DB",
  "use-case": "0052CC",
  infrastructure: "5319E7",
  api: "0E8A16",
  testing: "FBCA04",
  docs: "0075CA",
  ops: "C5DEF5",
  security: "B60205",
  stellar: "7057FF",
  "good first issue": "7057FF",
};

const LABEL_DESCRIPTIONS = {
  domain: "Domain modeling: entities and value objects",
  "use-case": "Application-layer orchestration",
  infrastructure: "Adapters, persistence, external integrations",
  api: "HTTP surface: routes, schemas, error mapping",
  testing: "Tests and test infrastructure",
  docs: "Documentation and guides",
  ops: "CI, Docker, deployment and tooling",
  security: "Security-critical — maintainer-reviewed, higher bar",
  stellar: "Stellar / on-chain anchoring",
};

function gh(args, { allowFailure = false } = {}) {
  const result = spawnSync("gh", args, { encoding: "utf8", shell: false });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`gh ${args.slice(0, 3).join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? "").trim(),
    stderr: result.stderr ?? "",
  };
}

function parseArgs(argv) {
  const args = { from: null, to: null, limit: null, execute: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--from") args.from = argv[i + 1];
    if (argv[i] === "--to") args.to = argv[i + 1];
    if (argv[i] === "--limit") args.limit = Number.parseInt(argv[i + 1], 10);
    if (argv[i] === "--execute") args.execute = true;
  }
  return args;
}

/** Roadmap ids already marked complete, which must never become open issues. */
async function completedIds() {
  const roadmap = await readFile(join(REPO_ROOT, "planning", "ROADMAP.md"), "utf8");
  const ids = new Set();
  for (const match of roadmap.matchAll(
    /^- \[x\][^\n]*?Issues?\s+(\d{3}[A-D]?)(?:\s*[–-]\s*(\d{3}))?/gm,
  )) {
    const start = Number.parseInt(match[1], 10);
    if (match[2]) {
      for (let n = start; n <= Number.parseInt(match[2], 10); n += 1) {
        ids.add(String(n).padStart(3, "0"));
      }
    } else {
      ids.add(match[1]);
    }
  }
  return ids;
}

/** Every `[NNN]` already on GitHub, open or closed, mapped to its issue number. */
function existingIssues() {
  const { stdout } = gh([
    "issue",
    "list",
    "--repo",
    REPO,
    "--state",
    "all",
    "--limit",
    "1000",
    "--json",
    "number,title",
  ]);
  const map = {};
  for (const issue of JSON.parse(stdout || "[]")) {
    const match = /^\[(\d{3}[A-D]?)\]/.exec(issue.title);
    if (match) map[match[1]] = issue.number;
  }
  return map;
}

function ensureLabels(labels, execute) {
  const { stdout } = gh(["label", "list", "--repo", REPO, "--limit", "200", "--json", "name"]);
  const existing = new Set(JSON.parse(stdout || "[]").map((l) => l.name));

  for (const label of labels) {
    if (existing.has(label)) continue;
    process.stdout.write(`  + label: ${label}\n`);
    if (!execute) continue;
    gh(
      [
        "label",
        "create",
        label,
        "--repo",
        REPO,
        "--color",
        LABEL_COLOURS[label] ?? "EDEDED",
        "--description",
        LABEL_DESCRIPTIONS[label] ?? `Roadmap label: ${label}`,
      ],
      { allowFailure: true },
    );
  }
}

function ensureMilestones(phases, execute) {
  const { stdout } = gh(["api", `repos/${REPO}/milestones?state=all&per_page=100`], {
    allowFailure: true,
  });
  const existing = new Map();
  for (const m of JSON.parse(stdout || "[]")) existing.set(m.title, m.number);

  for (const phase of phases) {
    const title = `Phase ${phase.number} — ${phase.title}`;
    if (existing.has(title)) continue;
    process.stdout.write(`  + milestone: ${title}\n`);
    if (!execute) continue;
    const created = gh(
      [
        "api",
        `repos/${REPO}/milestones`,
        "-f",
        `title=${title}`,
        "-f",
        `description=${phase.context.slice(0, 300)}`,
      ],
      { allowFailure: true },
    );
    if (created.ok) existing.set(title, JSON.parse(created.stdout).number);
  }
  return existing;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const { from, to, limit, execute } = parseArgs(process.argv.slice(2));

  const { issues, phases } = await loadRoadmap();
  const done = await completedIds();
  const existing = existingIssues();

  const candidates = issues
    .filter((issue) => {
      if (done.has(issue.id)) return false;
      if (existing[issue.id]) return false;
      const n = Number.parseInt(issue.id, 10);
      if (from && n < Number.parseInt(from, 10)) return false;
      if (to && n > Number.parseInt(to, 10)) return false;
      return true;
    })
    .sort(byRoadmapId);

  const selected = limit ? candidates.slice(0, limit) : candidates;

  process.stdout.write(
    `Repository:        ${REPO}\n` +
      `Roadmap issues:    ${String(issues.length)}\n` +
      `Already complete:  ${String(done.size)} (never created as open issues)\n` +
      `Already on GitHub: ${String(Object.keys(existing).length)}\n` +
      `Eligible to push:  ${String(candidates.length)}\n` +
      `This run:          ${String(selected.length)}` +
      (selected.length > 0 ? ` (${selected[0].id} → ${selected.at(-1).id})` : "") +
      `\nMode:              ${execute ? "EXECUTE — issues will be created" : "DRY RUN — nothing will be created"}\n\n`,
  );

  if (selected.length === 0) {
    process.stdout.write("Nothing to do.\n");
    return;
  }

  const neededLabels = [...new Set(selected.flatMap((issue) => labelsFor(issue)))];
  ensureLabels(neededLabels, execute);
  const milestones = ensureMilestones([...phases.values()], execute);

  await mkdir(join(REPO_ROOT, "build", "issues"), { recursive: true });
  const state = { ...existing };
  let created = 0;
  let failed = 0;

  for (const [index, issue] of selected.entries()) {
    const phase = phases.get(issue.phase);
    const title = renderIssueTitle(issue);
    const labels = labelsFor(issue);
    // Dependency links resolve to real issue numbers when those already
    // exist, so contributors can click through to the work this builds on.
    const body = renderIssueBody(issue, phase, state);
    const milestone = milestones.get(`Phase ${phase.number} — ${phase.title}`);

    const position = `[${String(index + 1).padStart(3, " ")}/${String(selected.length)}]`;

    if (!execute) {
      process.stdout.write(`${position} would create: ${title}  (${labels.join(", ")})\n`);
      continue;
    }

    const args = ["issue", "create", "--repo", REPO, "--title", title, "--body", body];
    for (const label of labels) args.push("--label", label);
    if (milestone) args.push("--milestone", `Phase ${phase.number} — ${phase.title}`);

    const result = gh(args, { allowFailure: true });
    if (result.ok) {
      const number = Number.parseInt(result.stdout.split("/").pop() ?? "", 10);
      if (Number.isFinite(number)) state[issue.id] = number;
      created += 1;
      process.stdout.write(`${position} #${String(state[issue.id] ?? "?")} ${title}\n`);
      await writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
    } else {
      failed += 1;
      process.stderr.write(`${position} FAILED ${title}\n  ${result.stderr.trim()}\n`);
    }

    if (index < selected.length - 1) await sleep(DELAY_MS);
  }

  if (execute) {
    process.stdout.write(`\nCreated ${String(created)}, failed ${String(failed)}.\n`);
    process.stdout.write(`State written to build/issues/pushed.json — re-run to resume.\n`);
  } else {
    process.stdout.write(`\nDry run complete. Add --execute to create these issues.\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
