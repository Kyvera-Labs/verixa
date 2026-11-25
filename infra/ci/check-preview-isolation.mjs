#!/usr/bin/env node
/**
 * Preview environment secrets & config isolation validator
 * (Phase 19, Issue #489 / roadmap 377).
 *
 * Enforces the security invariants between ephemeral PR preview deployments
 * and production:
 *   1. Preview deploy/teardown jobs are scoped to the `preview` GitHub
 *      Environment (never `production`, never unscoped).
 *   2. The preview workflow never uses `pull_request_target` (prevents
 *      untrusted fork code from executing with secret access).
 *   3. Secret-bearing preview jobs explicitly gate out fork-originated PRs
 *      (`head.repo.full_name == github.repository`).
 *   4. Only preview-scoped secret names (`PREVIEW_*`) are referenced; no
 *      `PROD_*`, `PRODUCTION_*`, or `LIVE_*` secrets appear.
 *   5. No production connection strings or live API keys appear in workflow
 *      config, environment manifests, or runtime environment variables.
 *   6. Per-PR Redis namespace isolation (`preview:pr-...`) is configured.
 *
 * Usage:
 *   node infra/ci/check-preview-isolation.mjs              # static config check
 *   node infra/ci/check-preview-isolation.mjs --check-env  # also validate process.env
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "../..");

export const DEFAULT_WORKFLOW_PATH = path.resolve(
  REPO_ROOT,
  ".github/workflows/preview-deploy.yml",
);
export const DEFAULT_ENVIRONMENT_PATH = path.resolve(REPO_ROOT, ".github/environments/preview.yml");

const PRODUCTION_SECRET_NAME_PATTERN = /\b(PROD|PRODUCTION|LIVE)_[A-Z0-9_]+\b/;
const SECRET_REF_PATTERN = /\bsecrets\.([A-Z0-9_]+)\b/g;

/**
 * Patterns that indicate a production connection string or live credential.
 * Matched against config text and (in --check-env mode) runtime env values.
 */
const PRODUCTION_CREDENTIAL_PATTERNS = [
  {
    label: "production database or redis host",
    regex:
      /(?:postgres(?:ql)?|rediss?):\/\/[^\s"'`]*?(?:prod(?:uction)?\.|\.prod\.|prod-|production-|\.rds\.amazonaws\.com)/i,
  },
  {
    label: "live API key prefix",
    regex: /\bvx_live_[A-Za-z0-9_-]+/,
  },
];

/**
 * Checks arbitrary text or environment values for production connection strings
 * or live API keys. Never includes the offending secret value in error messages
 * so a failed check cannot leak a credential into CI logs.
 *
 * @param {string} sourceName
 * @param {string} text
 * @returns {string[]}
 */
export function findProductionLeakage(sourceName, text) {
  const errors = [];
  for (const { label, regex } of PRODUCTION_CREDENTIAL_PATTERNS) {
    if (regex.test(text)) {
      errors.push(`${sourceName} contains a forbidden ${label}`);
    }
  }
  return errors;
}

/**
 * Validates runtime environment variables injected into a preview job so no
 * production connection string or live API key can slip through even if a
 * GitHub Environment secret was misconfigured.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
export function validatePreviewRuntimeEnv(env) {
  const errors = [];
  const inspectedKeys = ["DATABASE_URL", "DATABASE_MIGRATION_URL", "REDIS_URL", "PREVIEW_API_KEY"];

  for (const key of inspectedKeys) {
    const value = env[key];
    if (!value) continue;
    errors.push(...findProductionLeakage(`runtime env ${key}`, value));
  }

  return errors;
}

/**
 * Extracts the environment name from a GitHub Actions job's `environment`
 * field (which may be a string or an object with a `name` property).
 *
 * @param {unknown} envField
 * @returns {string | undefined}
 */
function getJobEnvironmentName(envField) {
  if (typeof envField === "string") return envField;
  if (envField && typeof envField === "object" && "name" in envField) {
    const name = /** @type {{ name?: unknown }} */ (envField).name;
    return typeof name === "string" ? name : undefined;
  }
  return undefined;
}

/**
 * Validates a parsed preview workflow YAML and its raw text against all
 * Issue #489 isolation invariants.
 *
 * @param {string} workflowText
 * @returns {string[]}
 */
export function validatePreviewWorkflow(workflowText) {
  const errors = [];

  /** @type {Record<string, any>} */
  let workflow;
  try {
    workflow = parseYaml(workflowText);
  } catch (err) {
    return [`preview workflow is not valid YAML: ${String(err)}`];
  }

  if (!workflow || typeof workflow !== "object") {
    return ["preview workflow YAML is empty or not an object"];
  }

  // 1. Trigger check: must use `pull_request` and never `pull_request_target`.
  const triggers = workflow.on ?? {};
  const triggerKeys =
    typeof triggers === "string"
      ? [triggers]
      : Array.isArray(triggers)
        ? triggers
        : Object.keys(triggers);

  if (triggerKeys.includes("pull_request_target")) {
    errors.push(
      "preview workflow must not use `pull_request_target` (exposes secrets to untrusted fork PRs)",
    );
  }
  if (!triggerKeys.includes("pull_request")) {
    errors.push("preview workflow must be triggered on `pull_request`");
  }

  // 2. Scan all `secrets.*` references across the workflow.
  const secretRefs = new Set();
  for (const match of workflowText.matchAll(SECRET_REF_PATTERN)) {
    const secretName = match[1];
    if (secretName) secretRefs.add(secretName);
  }

  for (const secretName of secretRefs) {
    if (secretName === "GITHUB_TOKEN") continue;
    if (PRODUCTION_SECRET_NAME_PATTERN.test(secretName)) {
      errors.push(
        `preview workflow references forbidden production secret \`secrets.${secretName}\``,
      );
    }
    if (!secretName.startsWith("PREVIEW_")) {
      errors.push(
        `preview workflow secret \`secrets.${secretName}\` must be prefixed with PREVIEW_`,
      );
    }
  }

  // 3. Validate each job's environment scoping and fork-PR guard.
  const jobs = workflow.jobs ?? {};
  let hasPreviewEnvJob = false;

  for (const [jobName, job] of Object.entries(jobs)) {
    if (!job || typeof job !== "object") continue;

    const jobSerialized = JSON.stringify(job);
    const jobUsesSecrets = /\bsecrets\.(?!GITHUB_TOKEN\b)[A-Z0-9_]+/.test(jobSerialized);
    const envName = getJobEnvironmentName(job.environment);

    if (envName === "production" || envName === "prod") {
      errors.push(`job \`${jobName}\` must not target the \`${envName}\` environment`);
    }

    if (jobUsesSecrets) {
      if (envName !== "preview") {
        errors.push(
          `job \`${jobName}\` accesses secrets and must be scoped to \`environment: preview\` (found: ${envName ?? "none"})`,
        );
      } else {
        hasPreviewEnvJob = true;
      }

      const condition = typeof job.if === "string" ? job.if : "";
      if (
        !condition.includes("github.event.pull_request.head.repo.full_name == github.repository")
      ) {
        errors.push(
          `job \`${jobName}\` accesses preview secrets and must guard against fork PRs with \`github.event.pull_request.head.repo.full_name == github.repository\``,
        );
      }
    }
  }

  if (!hasPreviewEnvJob) {
    errors.push("preview workflow must define at least one job scoped to `environment: preview`");
  }

  // 4. Per-PR Redis namespace isolation must be present.
  if (!workflowText.includes("preview:pr-")) {
    errors.push(
      "preview workflow must configure an isolated per-PR Redis namespace (`preview:pr-<number>:`)",
    );
  }

  // 5. No production connection strings or live API keys in workflow text.
  errors.push(...findProductionLeakage("preview workflow", workflowText));

  return errors;
}

/**
 * Validates `.github/environments/preview.yml`.
 *
 * @param {string} envManifestText
 * @returns {string[]}
 */
export function validatePreviewEnvironmentManifest(envManifestText) {
  const errors = [];

  /** @type {Record<string, any>} */
  let manifest;
  try {
    manifest = parseYaml(envManifestText);
  } catch (err) {
    return [`preview environment manifest is not valid YAML: ${String(err)}`];
  }

  if (!manifest || typeof manifest !== "object") {
    return ["preview environment manifest is empty or not an object"];
  }

  if (manifest.name !== "preview") {
    errors.push(
      `preview environment manifest \`name\` must be "preview" (found: ${String(manifest.name)})`,
    );
  }

  if (manifest.tier !== "non-production") {
    errors.push(
      `preview environment manifest \`tier\` must be "non-production" (found: ${String(manifest.tier)})`,
    );
  }

  if (manifest.protection_rules?.allow_fork_pull_requests !== false) {
    errors.push(
      "preview environment manifest must set `protection_rules.allow_fork_pull_requests: false`",
    );
  }

  const secrets = Array.isArray(manifest.secrets) ? manifest.secrets : [];
  if (secrets.length === 0) {
    errors.push("preview environment manifest must declare its scoped preview secrets");
  }

  for (const secret of secrets) {
    const name = typeof secret?.name === "string" ? secret.name : "";
    if (!name.startsWith("PREVIEW_")) {
      errors.push(`preview environment secret \`${name}\` must be prefixed with PREVIEW_`);
    }
    if (PRODUCTION_SECRET_NAME_PATTERN.test(name)) {
      errors.push(`preview environment manifest must not declare production secret \`${name}\``);
    }
    if (secret?.tier === "production") {
      errors.push(`preview environment secret \`${name}\` must not have tier "production"`);
    }
  }

  errors.push(...findProductionLeakage("preview environment manifest", envManifestText));

  return errors;
}

/**
 * Runs the full preview isolation check against files on disk (and optionally
 * `process.env`).
 *
 * @param {{ workflowPath?: string; environmentPath?: string; checkEnv?: boolean; env?: Record<string, string | undefined> }} [options]
 * @returns {{ ok: boolean; errors: string[] }}
 */
export function checkPreviewIsolation(options = {}) {
  const workflowPath = options.workflowPath ?? DEFAULT_WORKFLOW_PATH;
  const environmentPath = options.environmentPath ?? DEFAULT_ENVIRONMENT_PATH;
  const errors = [];

  if (!existsSync(workflowPath)) {
    errors.push(`missing preview workflow: ${workflowPath}`);
  } else {
    errors.push(...validatePreviewWorkflow(readFileSync(workflowPath, "utf-8")));
  }

  if (!existsSync(environmentPath)) {
    errors.push(`missing preview environment manifest: ${environmentPath}`);
  } else {
    errors.push(...validatePreviewEnvironmentManifest(readFileSync(environmentPath, "utf-8")));
  }

  if (options.checkEnv) {
    errors.push(...validatePreviewRuntimeEnv(options.env ?? process.env));
  }

  return { ok: errors.length === 0, errors };
}

// CLI entrypoint
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const checkEnv = process.argv.includes("--check-env");
  const result = checkPreviewIsolation({ checkEnv });

  if (!result.ok) {
    for (const err of result.errors) {
      console.error(`::error::${err}`);
    }
    process.exit(1);
  }

  console.log(
    checkEnv
      ? "Preview environment isolation and runtime env checks passed."
      : "Preview environment isolation checks passed.",
  );
}
