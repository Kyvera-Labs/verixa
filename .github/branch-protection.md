# Branch Protection & Required Status Checks Policy

This document codifies the branch protection policy for `main` (Phase 19, Issue 366 / #478).
The machine-readable ruleset lives alongside this file in [`.github/branch-protection.json`](./branch-protection.json) and is validated in CI by `infra/ci/check-branch-protection.mjs` so that workflow job renames cannot silently orphan a required status check.

## Why Branch Protection Matters

There is a fundamental gap between **"CI runs"** and **"CI enforces"**. A workflow that runs on every pull request but does not block merge provides false confidence: under time pressure, a failing check can be ignored or merged around, leaving `main` broken for every contributor who branches off it next.

Branch protection closes that gap by turning CI checks and code review into hard merge gates enforced by GitHub itself.

## Protected Branch: `main`

### Core Rules

| Rule                                                                       | Setting | Rationale                                                                                                          |
| -------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| Prevent branch deletion                                                    | Enabled | `main` is the canonical release branch; accidental deletion breaks open PRs and CI caches.                         |
| Prevent force pushes                                                       | Enabled | Preserves linear, auditable commit history required by `semantic-release` and security audits.                     |
| Require pull request before merging                                        | Enabled | No direct pushes to `main`; every change goes through review and CI.                                               |
| Required approving reviews                                                 | `1`     | Ensures at least one pair of eyes beyond the author verifies correctness and security.                             |
| Dismiss stale pull request approvals                                       | Enabled | A new commit pushed after approval invalidates the prior review so unreviewed code cannot slip in.                 |
| Require conversation resolution                                            | Enabled | Prevents open review feedback from being forgotten at merge time.                                                  |
| Require branches to be up to date (`strict_required_status_checks_policy`) | Enabled | Prevents semantic merge conflicts where two PRs pass individually against an older `main` but break when combined. |
| Bypass actors                                                              | None    | Maintainers follow the same gates as external contributors.                                                        |

### Required Status Checks

Every check listed in `.github/branch-protection.json` must report `success` before a pull request can merge into `main`:

| Status Check Context            | Workflow File                           | Category              | What It Enforces                                                                                                                                                                      |
| ------------------------------- | --------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci`                            | `.github/workflows/ci.yml`              | Lint, Typecheck, Test | Lockfile integrity, malware indicators, OpenAPI contract, Prisma migrations/drift, ESLint, Prettier, env matrix sync, TypeScript, unit/integration tests, per-package coverage gates. |
| `testcontainers`                | `.github/workflows/ci.yml`              | Test                  | Repository contract tests against ephemeral Testcontainers Postgres.                                                                                                                  |
| `e2e`                           | `.github/workflows/ci.yml`              | Test                  | Process-level HTTP smoke test against disposable Postgres and Redis.                                                                                                                  |
| `compose-database-roles`        | `.github/workflows/ci.yml`              | Security / Test       | Verifies the `verixa_app` role is unprivileged and subject to Row Level Security (RLS).                                                                                               |
| `docker`                        | `.github/workflows/ci.yml`              | Build / Security      | Production Docker build, Trivy OS & library scan, non-root UID, pruned bundle, rollback drill.                                                                                        |
| `compose-production-smoke`      | `.github/workflows/ci.yml`              | Build / Test          | Merged `docker-compose.prod.yml` config validation and live `/health` check.                                                                                                          |
| `compose-backup-restore`        | `.github/workflows/ci.yml`              | Reliability           | Backup and full volume-destroy restore drill for Postgres and Redis.                                                                                                                  |
| `workspace-coverage`            | `.github/workflows/coverage.yml`        | Coverage              | Merged workspace coverage report and baseline ratchet gate (coverage cannot regress).                                                                                                 |
| `Audit production dependencies` | `.github/workflows/dependency-scan.yml` | Security              | Blocks newly introduced unexcepted HIGH/CRITICAL production dependency advisories.                                                                                                    |
| `Scan the runtime image`        | `.github/workflows/container-scan.yml`  | Security              | Trivy container vulnerability gate with expiring waiver validation.                                                                                                                   |
| `commitlint`                    | `.github/workflows/commitlint.yml`      | Release Hygiene       | Enforces Conventional Commits required by automated versioning and changelog generation.                                                                                              |

## Judgement Calls & Rejected Alternatives

### Why GitHub Repository Rulesets JSON instead of Terraform or Probot Settings?

- **Rejected: Terraform (`github_branch_protection`)** — Requires provisioning and securing a remote state backend (e.g., S3/Terraform Cloud) and a long-lived admin PAT just to manage a single repository's branch rules. That operational overhead is disproportionate for an open-source repository.
- **Rejected: Probot Settings (`.github/settings.yml`)** — Requires installing a third-party GitHub App with `administration: write` permissions on the repository.
- **Chosen: Checked-in GitHub Repository Rulesets JSON (`.github/branch-protection.json`)** — Natively supported by GitHub's REST API and UI import/export, requires zero external state or third-party apps, is version-controlled alongside the workflows it references, and is verified by `infra/ci/check-branch-protection.mjs` on every PR.

### Why `Publish API container` (`docker-publish.yml`) is not a required check

`docker-publish.yml` uses a `pull_request.paths` filter so it only runs when Docker-related files change. Marking a path-filtered workflow as a required status check causes GitHub to wait indefinitely ("Expected — Waiting for status to be reported") on documentation-only or unrelated PRs. Container build and security verification for _every_ PR is already enforced unconditionally by the `docker` job in `ci.yml` and `Scan the runtime image` in `container-scan.yml`.

## Reproducing / Applying This Policy

If the repository is recreated or migrated, apply the policy using either method below.

### Option 1: GitHub CLI (`gh api`)

Requires a repository administrator token with `administration: write`:

```bash
gh api \
  --method POST \
  -H "Accept: application/vnd.github+json" \
  /repos/Kyvera-Labs/verixa/rulesets \
  --input .github/branch-protection.json
```

To update an existing ruleset, replace `POST` with `PUT` and append `/<ruleset_id>` to the endpoint.

### Option 2: GitHub Web UI Checklist

1. Navigate to **Settings → Rules → Rulesets → New ruleset → Import a ruleset** and upload `.github/branch-protection.json`.
2. Alternatively, create a **New branch ruleset** manually:
   - **Name**: `Protect main`
   - **Enforcement status**: `Active`
   - **Target branches**: Include `Default branch` (`main`)
   - **Branch rules**:
     - [x] Restrict deletions
     - [x] Block force pushes
     - [x] Require a pull request before merging (`1` approving review, dismiss stale approvals on push, require conversation resolution)
     - [x] Require status checks to pass (enable "Require branches to be up to date before merging" and add all 11 contexts listed in the table above)
3. Click **Create**.
