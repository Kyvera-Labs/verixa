#!/usr/bin/env node
/**
 * Validates `.github/branch-protection.json` against `.github/workflows/*.yml`:
 *
 * 1. The ruleset targets the default branch and is active.
 * 2. Deletion and force-push are blocked, and pull request review and strict required status checks
 *    are enabled.
 * 3. Every required status check exists as a job name (or job key when `name` is omitted), so a
 *    workflow refactor cannot leave pull requests waiting on a check that never runs.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * Collects all GitHub Actions check contexts emitted by workflows in a directory.
 * GitHub uses `job.name` when present, otherwise the YAML job key.
 * Zero-dependency parser so the check can run before `pnpm install`.
 *
 * @param {string} workflowsDir
 * @returns {Set<string>}
 */
export function collectWorkflowCheckContexts(workflowsDir) {
  const contexts = new Set();
  if (!fs.existsSync(workflowsDir)) {
    return contexts;
  }

  for (const entry of fs.readdirSync(workflowsDir)) {
    if (!entry.endsWith(".yml") && !entry.endsWith(".yaml")) continue;
    const lines = fs.readFileSync(path.join(workflowsDir, entry), "utf8").split(/\r?\n/);

    let inJobs = false;
    let currentJobId = null;
    let currentJobName = null;

    const flushJob = () => {
      if (currentJobId) {
        contexts.add(currentJobName ?? currentJobId);
      }
      currentJobId = null;
      currentJobName = null;
    };

    for (const line of lines) {
      if (/^jobs:\s*(#.*)?$/.test(line)) {
        inJobs = true;
        continue;
      }
      if (inJobs && /^[A-Za-z0-9_-]+:/.test(line)) {
        flushJob();
        inJobs = false;
        continue;
      }
      if (!inJobs) continue;

      const jobMatch = /^  ([A-Za-z0-9_-]+):\s*(#.*)?$/.exec(line);
      if (jobMatch) {
        flushJob();
        currentJobId = jobMatch[1];
        continue;
      }

      if (currentJobId && currentJobName === null) {
        const nameMatch = /^    name:\s*(.+?)\s*$/.exec(line);
        if (nameMatch) {
          currentJobName = nameMatch[1].replace(/^['"]|['"]$/g, "").trim();
        }
      }
    }
    flushJob();
  }

  return contexts;
}

/**
 * Validates a parsed branch protection ruleset against available workflow contexts.
 *
 * @param {unknown} ruleset
 * @param {Set<string>} workflowContexts
 * @returns {string[]} List of validation error messages (empty when valid).
 */
export function validateBranchProtection(ruleset, workflowContexts) {
  const errors = [];

  if (!ruleset || typeof ruleset !== "object") {
    return ["Branch protection ruleset must be a JSON object."];
  }

  if (ruleset.enforcement !== "active") {
    errors.push(`Expected enforcement to be "active", got "${String(ruleset.enforcement)}".`);
  }

  const includes = ruleset.conditions?.ref_name?.include;
  if (
    !Array.isArray(includes) ||
    (!includes.includes("~DEFAULT_BRANCH") && !includes.includes("refs/heads/main"))
  ) {
    errors.push('Ruleset must target "~DEFAULT_BRANCH" or "refs/heads/main".');
  }

  const rules = Array.isArray(ruleset.rules) ? ruleset.rules : [];
  const ruleTypes = new Set(rules.map((r) => r?.type));

  if (!ruleTypes.has("deletion")) {
    errors.push('Ruleset must include a "deletion" rule to prevent branch deletion.');
  }
  if (!ruleTypes.has("non_fast_forward")) {
    errors.push('Ruleset must include a "non_fast_forward" rule to block force pushes.');
  }

  const prRule = rules.find((r) => r?.type === "pull_request");
  if (!prRule) {
    errors.push('Ruleset must include a "pull_request" rule.');
  } else {
    const minReviews = prRule.parameters?.required_approving_review_count ?? 0;
    if (minReviews < 1) {
      errors.push(`required_approving_review_count must be >= 1, got ${minReviews}.`);
    }
    if (prRule.parameters?.dismiss_stale_reviews_on_push !== true) {
      errors.push("dismiss_stale_reviews_on_push must be true.");
    }
  }

  const statusRule = rules.find((r) => r?.type === "required_status_checks");
  if (!statusRule) {
    errors.push('Ruleset must include a "required_status_checks" rule.');
  } else {
    if (statusRule.parameters?.strict_required_status_checks_policy !== true) {
      errors.push("strict_required_status_checks_policy must be true.");
    }
    const checks = statusRule.parameters?.required_status_checks;
    if (!Array.isArray(checks) || checks.length === 0) {
      errors.push("required_status_checks must list at least one status check context.");
    } else {
      for (const check of checks) {
        const ctx = check?.context;
        if (typeof ctx !== "string" || !ctx.trim()) {
          errors.push("Every required_status_checks entry must have a non-empty string context.");
          continue;
        }
        if (!workflowContexts.has(ctx)) {
          errors.push(
            `Required status check "${ctx}" does not match any job in .github/workflows/*.yml.`,
          );
        }
      }
    }
  }

  return errors;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

if (isMain) {
  const repoRoot = process.cwd();
  const rulesetPath = path.join(repoRoot, ".github", "branch-protection.json");
  const workflowsDir = path.join(repoRoot, ".github", "workflows");

  if (!fs.existsSync(rulesetPath)) {
    console.error(`Missing branch protection ruleset: ${rulesetPath}`);
    process.exit(1);
  }

  const ruleset = JSON.parse(fs.readFileSync(rulesetPath, "utf8"));
  const contexts = collectWorkflowCheckContexts(workflowsDir);
  const errors = validateBranchProtection(ruleset, contexts);

  if (errors.length > 0) {
    for (const err of errors) {
      console.error(`::error::${err}`);
    }
    process.exit(1);
  }

  console.log(
    `Branch protection policy valid (${ruleset.rules.find((r) => r.type === "required_status_checks").parameters.required_status_checks.length} required status checks verified).`,
  );
}
