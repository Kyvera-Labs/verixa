# Preview Environment Secrets & Config Isolation

This document explains how Verixa isolates secrets and configuration for ephemeral per-PR preview environments (Phase 19, Issue #489 / roadmap 377), and why the pipeline is structured the way it is.

## Threat Model: Why Preview Pipelines Leak Credentials

CI/CD preview pipelines are one of the highest-leverage credential-leak vectors in open-source repositories:

1. **Untrusted code execution on pull requests**: A preview deployment builds and boots code from a pull request before a maintainer has merged it. If that job has access to production or repository-wide secrets, a single malicious commit can exfiltrate them via HTTP, DNS, or build logs.
2. **Fork-PR escalation (`pull_request_target`)**: Workflows triggered by `pull_request_target` execute in the context of the base repository with access to secrets. Checking out the PR head inside `pull_request_target` lets an external contributor run arbitrary code with those secrets.
3. **Cross-PR and cross-tier data contamination**: If preview environments share a production database, a production Redis instance without key-prefix isolation, or production signing keys, a bug or exploit in a preview PR can read or corrupt live tenant data — or mint session tokens accepted by production.

## Isolation Architecture

Verixa enforces defense in depth across four layers:

### 1. Dedicated `preview` GitHub Environment

All preview credentials live exclusively in a dedicated GitHub Environment named `preview` (declared in [`.github/environments/preview.yml`](../../.github/environments/preview.yml)), completely separate from `production`.

Every secret in this environment is prefixed with `PREVIEW_` and provisioned at the **test tier**:

| Secret                                | Purpose                                     | Isolation Property                                                       |
| ------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------ |
| `PREVIEW_DATABASE_URL`                | Unprivileged app DB connection for previews | Test-tier Postgres instance; never a production host or superuser        |
| `PREVIEW_DATABASE_MIGRATION_URL`      | Migration role for preview schemas          | Scoped exclusively to preview databases                                  |
| `PREVIEW_REDIS_URL`                   | Cache / session deny-list store             | Non-production Redis paired with `preview:pr-<N>:` key prefix            |
| `PREVIEW_SESSION_ACCESS_TOKEN_SECRET` | JWT/session signing key (`>= 32` chars)     | Distinct from production so preview tokens are never valid in production |
| `PREVIEW_API_KEY`                     | Test-tier API key (`vx_preview_*`)          | Never a live key (`vx_live_*`)                                           |
| `PREVIEW_DEPLOY_TOKEN`                | Ephemeral deploy/teardown token             | Least-privilege; cannot modify staging or production infrastructure      |

### 2. Fork-PR Secret Restrictions

[`.github/workflows/preview-deploy.yml`](../../.github/workflows/preview-deploy.yml) uses the `pull_request` trigger — **never** `pull_request_target`.

- By default, GitHub withholds all repository and environment secrets from `pull_request` workflows triggered by forks.
- In addition, both `deploy-preview` and `teardown-preview` explicitly gate on:
  ```yaml
  github.event.pull_request.head.repo.full_name == github.repository
  ```
- The `verify-preview-isolation` job runs on all PRs (including forks) with **zero secrets**, so external contributors still receive immediate feedback if their PR weakens preview isolation rules.

### 3. Per-PR Data & Cache Namespacing

Each preview deployment scopes its mutable state to the PR number:

- **Database schema**: `verixa_pr_<pr_number>`
- **Redis namespace**: `preview:pr-<pr_number>:`

When the PR is closed or merged, `teardown-preview` releases the per-PR schema and flushes the per-PR Redis namespace.

### 4. Automated Static & Runtime Guards

[`infra/ci/check-preview-isolation.mjs`](../../infra/ci/check-preview-isolation.mjs) runs in CI (and in runtime `--check-env` mode before deployment) to fail closed if:

- `pull_request_target` is introduced into `preview-deploy.yml`
- Any secret-bearing job omits `environment: preview` or targets `production`
- Any secret-bearing job omits the fork-PR guard
- Any `PROD_*`, `PRODUCTION_*`, or `LIVE_*` secret is referenced
- Any production database/Redis connection string or `vx_live_*` key appears in workflow config or injected runtime environment variables (without ever echoing the offending value to logs)

## Design Decisions & Rejected Alternatives

### Rejected: `pull_request_target` with label-gated maintainer approval

**Alternative considered**: Triggering preview deploys on `pull_request_target` once a maintainer applies a `deploy-preview` label.

**Why rejected**: Label-gated `pull_request_target` is fragile against TOCTOU (time-of-check to time-of-use) races — if a contributor pushes a new commit after the label is applied, the workflow can run untrusted code with secret access unless every commit SHA is re-approved. Using `pull_request` plus GitHub Environment protection rules keeps fork PRs secret-free by default and eliminates the entire `pull_request_target` attack surface.

### Rejected: Repository-level secrets shared with staging

**Alternative considered**: Storing `PREVIEW_*` secrets at the repository level or reusing staging database/Redis credentials.

**Why rejected**: Repository-level secrets are accessible to any workflow in the repository without environment protection rules or required-reviewer gates. Scoping them to the `preview` GitHub Environment ensures only explicitly scoped jobs can request them and lets maintainers enforce branch and reviewer policies in one place.

### Rejected: Dedicated Redis cluster per PR

**Alternative considered**: Provisioning a fresh Redis instance per PR preview.

**Why rejected**: Provisioning a full Redis instance per PR adds minutes of cold-start latency and unnecessary infrastructure cost for ephemeral previews. Pairing a dedicated non-production Redis instance with a mandatory `preview:pr-<N>:` key prefix gives fast, deterministic isolation without touching production.
