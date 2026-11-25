import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  checkPreviewIsolation,
  DEFAULT_ENVIRONMENT_PATH,
  DEFAULT_WORKFLOW_PATH,
  findProductionLeakage,
  REPO_ROOT,
  validatePreviewEnvironmentManifest,
  validatePreviewRuntimeEnv,
  validatePreviewWorkflow,
} from "../../infra/ci/check-preview-isolation.mjs";

const DOC_PATH = path.resolve(REPO_ROOT, "docs/security/preview-environment-isolation.md");

describe("Preview environment secrets & config isolation (Issue #489)", () => {
  it("passes all isolation checks on the repository preview workflow and environment manifest", () => {
    const result = checkPreviewIsolation({
      workflowPath: DEFAULT_WORKFLOW_PATH,
      environmentPath: DEFAULT_ENVIRONMENT_PATH,
    });

    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("rejects a preview workflow that uses pull_request_target", () => {
    const unsafeWorkflow = `
name: Unsafe Preview
on:
  pull_request_target:
    types: [opened]
jobs:
  deploy:
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    environment: preview
    env:
      PREVIEW_REDIS_NAMESPACE: "preview:pr-1:"
      DATABASE_URL: \${{ secrets.PREVIEW_DATABASE_URL }}
    steps:
      - run: echo "deploy"
`;

    const errors = validatePreviewWorkflow(unsafeWorkflow);
    expect(errors.some((e) => e.includes("pull_request_target"))).toBe(true);
  });

  it("rejects a secret-bearing preview job that is not scoped to the preview environment", () => {
    const unscopedWorkflow = `
name: Unscoped Preview
on:
  pull_request:
jobs:
  deploy:
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    env:
      PREVIEW_REDIS_NAMESPACE: "preview:pr-1:"
      DATABASE_URL: \${{ secrets.PREVIEW_DATABASE_URL }}
    steps:
      - run: echo "deploy"
`;

    const errors = validatePreviewWorkflow(unscopedWorkflow);
    expect(errors.some((e) => e.includes("environment: preview"))).toBe(true);
  });

  it("rejects a preview job targeting the production environment", () => {
    const prodTargetWorkflow = `
name: Prod Target Preview
on:
  pull_request:
jobs:
  deploy:
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    environment: production
    env:
      PREVIEW_REDIS_NAMESPACE: "preview:pr-1:"
      DATABASE_URL: \${{ secrets.PREVIEW_DATABASE_URL }}
    steps:
      - run: echo "deploy"
`;

    const errors = validatePreviewWorkflow(prodTargetWorkflow);
    expect(errors.some((e) => e.includes("must not target the `production`"))).toBe(true);
  });

  it("rejects a secret-bearing preview job that omits the fork-PR guard", () => {
    const unguardedForkWorkflow = `
name: Unguarded Fork Preview
on:
  pull_request:
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: preview
    env:
      PREVIEW_REDIS_NAMESPACE: "preview:pr-1:"
      DATABASE_URL: \${{ secrets.PREVIEW_DATABASE_URL }}
    steps:
      - run: echo "deploy"
`;

    const errors = validatePreviewWorkflow(unguardedForkWorkflow);
    expect(
      errors.some((e) =>
        e.includes("github.event.pull_request.head.repo.full_name == github.repository"),
      ),
    ).toBe(true);
  });

  it("rejects production secret references in the preview workflow", () => {
    const prodSecretWorkflow = `
name: Prod Secret Preview
on:
  pull_request:
jobs:
  deploy:
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    environment: preview
    env:
      PREVIEW_REDIS_NAMESPACE: "preview:pr-1:"
      DATABASE_URL: \${{ secrets.PRODUCTION_DATABASE_URL }}
    steps:
      - run: echo "deploy"
`;

    const errors = validatePreviewWorkflow(prodSecretWorkflow);
    expect(errors.some((e) => e.includes("secrets.PRODUCTION_DATABASE_URL"))).toBe(true);
  });

  it("rejects a preview workflow missing per-PR Redis namespace isolation", () => {
    const sharedRedisWorkflow = `
name: Shared Redis Preview
on:
  pull_request:
jobs:
  deploy:
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    environment: preview
    env:
      DATABASE_URL: \${{ secrets.PREVIEW_DATABASE_URL }}
    steps:
      - run: echo "deploy"
`;

    const errors = validatePreviewWorkflow(sharedRedisWorkflow);
    expect(errors.some((e) => e.includes("Redis namespace"))).toBe(true);
  });

  it("detects production connection strings and live API keys without echoing the secret", () => {
    const prodDb = "postgres://verixa:supersecret@prod.db.verixa.dev:5432/verixa";
    const liveKey = "vx_live_abc123def456";

    const dbErrors = findProductionLeakage("test-config", prodDb);
    expect(dbErrors.length).toBe(1);
    expect(dbErrors[0]).not.toContain("supersecret");

    const keyErrors = findProductionLeakage("test-config", liveKey);
    expect(keyErrors.length).toBe(1);
    expect(keyErrors[0]).not.toContain(liveKey);
  });

  it("validates runtime environment variables and rejects production URLs", () => {
    const cleanErrors = validatePreviewRuntimeEnv({
      DATABASE_URL: "postgres://verixa_preview:test@preview-db.internal:5432/verixa_pr_42",
      REDIS_URL: "redis://preview-redis.internal:6379",
      PREVIEW_API_KEY: "vx_preview_test_key_001",
    });
    expect(cleanErrors).toEqual([]);

    const dirtyErrors = validatePreviewRuntimeEnv({
      DATABASE_URL: "postgres://verixa:secret@verixa.prod.rds.amazonaws.com:5432/verixa",
      PREVIEW_API_KEY: "vx_live_should_never_be_here",
    });
    expect(dirtyErrors.length).toBe(2);
  });

  it("rejects a preview environment manifest that allows fork PRs by default", () => {
    const unsafeManifest = `
name: preview
tier: non-production
protection_rules:
  allow_fork_pull_requests: true
secrets:
  - name: PREVIEW_DATABASE_URL
    tier: test
`;

    const errors = validatePreviewEnvironmentManifest(unsafeManifest);
    expect(errors.some((e) => e.includes("allow_fork_pull_requests: false"))).toBe(true);
  });

  it("documents the preview environment isolation model and trade-offs", () => {
    expect(existsSync(DOC_PATH)).toBe(true);
    const doc = readFileSync(DOC_PATH, "utf-8");
    expect(doc).toContain("pull_request_target");
    expect(doc).toContain("preview");
    expect(doc).toContain("PREVIEW_DATABASE_URL");
    expect(doc).toContain("preview:pr-");
  });
});
