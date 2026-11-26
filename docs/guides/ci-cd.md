# CI/CD

## Continuous Integration

`.github/workflows/ci.yml` runs on every push to `main` and every pull
request: install → build → lint → format check → typecheck → test.

It intentionally runs the _exact same commands_ a contributor runs locally
(`pnpm lint`, `pnpm typecheck`, `pnpm test`, ...) rather than reimplementing
equivalent logic as inline CI script. This matters for two reasons:

1. **"Works on my machine, fails in CI" becomes structurally impossible** for
   these checks — if `pnpm lint` passes locally, it passes in CI, because
   it's the same command against the same config, not a CI-specific
   variant that could drift out of sync.
2. **The local pre-commit hook (Issue 009) and CI are the same gate at two
   different points in time** — the hook is a fast local preview, CI is the
   actual, unbypassable enforcement (see `CONTRIBUTING.md`'s "Local git
   hooks" section for that distinction).

### Build-first ordering

`pnpm build` runs before every other check, even lint. TypeScript's module
resolution happens to fall back to a dependency's raw `.ts` source and still
typecheck successfully when that dependency hasn't been built yet (see
`docs/guides/typescript-conventions.md`) — but that fallback only applies to
a package's `main`/`types` field, which supports the classic Node
directory-index fallback. It does **not** apply to `package.json` `exports`
subpaths: `apps/api` exposes `buildApp` via `"./app": "./dist/app.d.ts"`
(Issue 015, so `tests/` can boot the app in-process without triggering
`server.ts`'s side effects), and `exports` resolution is exact — if
`dist/app.d.ts` doesn't exist, resolution fails outright instead of falling
back to source. The first time that happened, it didn't surface as a clean
"module not found" either: ESLint's type-aware rules silently treated the
unresolved import as `any`, which cascaded into nine unrelated-looking
`no-unsafe-*` errors on the very next line that touched it. `pnpm test` has
no fallback either way — Vitest doesn't transform `node_modules` packages, so
a test importing `@verixa/config` needs its real, built `dist/index.js`, or
it fails with `ERR_MODULE_NOT_FOUND`. Building first, unconditionally, before
_anything_ else runs, keeps CI correct regardless of which check happens to
tolerate a missing build and which doesn't — and regardless of whether a
future check's failure mode on a missing build is an obvious error or a
confusing cascade of unrelated ones.

### `pnpm` caching and shared workspace setup

All workflows that install dependencies share the composite action `.github/actions/setup-workspace/action.yml`. It configures `pnpm`, installs the requested Node.js LTS version (default `22`, matching `package.json#engines.node`), and enables `actions/setup-node`'s `cache: pnpm`.

#### Why lockfile-hash cache keys instead of branch-based keys

The pnpm store cache is keyed strictly on the hash of `pnpm-lock.yaml` rather than on the Git branch name:

- **Correctness**: a branch-keyed cache can serve stale dependency trees after a rebase or lockfile update.
- **Security (cache poisoning)**: overly broad fallback keys (such as prefixing by branch) allow an untrusted pull request to pollute cache entries read by other runs. Keying on the lockfile hash guarantees that a cache hit matches the exact dependency graph verified by `infra/ci/check-lockfile-integrity.mjs`.

On a warm cache, `pnpm install --frozen-lockfile` completes in ~5-15 seconds compared to ~60-90 seconds uncached.

#### Why CI runs one Node LTS on `ubuntu-latest`

`.github/workflows/ci.yml` runs Node 22, the active LTS, on `ubuntu-latest`. It is not written as a one-entry matrix: GitHub appends matrix values to the check name (`ci (22)`), and branch protection requires a check named `ci`. Testing a second LTS means adding the matrix and updating the required checks together. Adding `macos-latest` or `windows-latest` runners was rejected because Linux containers are the sole production deployment target, and non-Linux runners multiply GitHub Actions minute cost by 5-10x without catching production regressions.

## Pipeline Stages

Static analysis runs in `.github/workflows/lint.yml` as an **independent, parallel workflow** alongside `.github/workflows/ci.yml`:

- Runs ESLint (`pnpm lint`), Prettier (`pnpm format:check`), and strict TypeScript typechecking (`pnpm typecheck` and `pnpm typecheck:ci`) with GitHub PR diff annotations enabled via a problem matcher.
- **Why parallel instead of only inside the test job**: burying lint and typecheck behind Postgres/Redis service containers and integration tests delays contributor feedback and mixes static-analysis failures with runtime test failures. Running them in an independent workflow isolates the failure signal and fails fast in ~1 minute.

## Image Publishing

Images are published from exactly one workflow, so two pipelines never race to push the same tags.

`.github/workflows/docker-publish.yml` builds the `apps/api` production container image from `apps/api/Dockerfile` (`target: production`) and publishes it to GitHub Container Registry (`ghcr.io/<owner>/verixa-api`):

- **Multi-stage builds**: `apps/api/Dockerfile` separates dependency installation and TypeScript compilation (`deps` / `build` stages) from the minimal `production` runtime stage. Dev dependencies, TypeScript compilers, source maps, and package managers (`npm`, `npx`, `corepack`) are never shipped in the final image, shrinking image size and reducing the production attack surface.
- **Tagging**: every build is tagged with `sha-<short>` for immutable commit traceability; semantic version tags (`vX.Y.Z`) additionally publish the `X.Y.Z` tag; pushes to `main` update `latest`.
- **PR build-only verification**: the `docker` job in `.github/workflows/ci.yml` builds the image on every pull request, without pushing, to verify that the Dockerfile and ESM runtime bundle remain healthy without pushing untrusted artifacts to GHCR.
- **Single canonical Dockerfile**: we use `apps/api/Dockerfile` directly rather than duplicating a second Dockerfile under `infra/docker/Dockerfile`, preventing configuration drift between CI hardening checks and published images.

## Branch Protection & Required Status Checks

CI only protects `main` when GitHub is configured to block merges on failing checks. The gap between "CI runs" and "CI enforces" is closed by the repository's branch protection policy:

- **Policy & Reproducible Setup**: [`.github/branch-protection.md`](../../.github/branch-protection.md)
- **Machine-Readable GitHub Ruleset**: [`.github/branch-protection.json`](../../.github/branch-protection.json)
- **Drift Validator**: `infra/ci/check-branch-protection.mjs` verifies that every required status check context in `.github/branch-protection.json` matches an actual job in `.github/workflows/*.yml` so a job rename can never silently orphan a merge gate.

## Continuous Delivery

Release automation (the manual Semantic release workflow, GitHub Releases, and the tag-triggered SBOM) is documented in [`docs/guides/release-process.md`](./release-process.md).

## Pipeline Observability & Failure Notifications

Continuous Integration is only as effective as its feedback loop. A test suite
that catches regressions but whose failures go unnoticed for hours or days defeats
the foundational premise of continuous integration: that `main` is always deployable
and regressions are addressed immediately by the authors who introduced them.

### Active Failure Alerting

Pipeline failures on `main` are surfaced actively via `.github/workflows/notify-on-failure.yml`.
Rather than embedding alert steps inside each individual workflow (which would fail to
execute if a runner crashes, runs out of memory, or exceeds a job timeout), alerting is
architected via GitHub Actions' `workflow_run` event:

1. **Independent Execution Boundary**: The notification workflow triggers after the target
   workflow (CI, Release, Deploy, Container Scan) completes on the `main` branch. It executes
   in an isolated runner context regardless of why or how the target workflow terminated.
2. **Actionable Context**: Every failure alert payload carries the critical triage
   context required to diagnose the problem without digging through logs:
   - Failing workflow name and run number
   - Git commit SHA and commit message
   - Commit author / trigger actor
   - Direct link to the execution logs on GitHub
3. **Adapter-Based Dispatch**: Supports notification delivery across Slack, Discord,
   and generic webhooks via webhook secrets (`SLACK_WEBHOOK_URL`, `DISCORD_WEBHOOK_URL`,
   `ALERT_WEBHOOK_URL`). If no external chat provider is configured, failure summaries
   are recorded directly to the GitHub Actions Job Summary (`$GITHUB_STEP_SUMMARY`).

### Pipeline Health Dashboard

Mean-Time-To-Detection (MTTD) and overall pipeline stability are monitored via an
automated dashboard generator in `scripts/ci-dashboard/generate.ts`.

Running on a scheduled daily cadence (06:00 UTC) and on-demand via `workflow_dispatch`,
the script queries the workflow run history across the repository and computes key health
indicators over a rolling 30-day window:

- **Pass Rate**: The percentage of decisive runs (`success / (success + failure)`) overall
  and broken down per workflow. Maintained targets are >= 95% (Healthy), 90-94% (Warning),
  and < 90% (Critical).
- **Mean & Percentile Duration**: Average, median (p50), and 95th-percentile (p95) runtime
  for each pipeline, ensuring build duration regressions and slow tests are identified before
  developer productivity degrades.
- **Recent Failures**: A chronological log of recent failures on `main` with direct links
  to failing run logs.

The generated report (`ci-dashboard.md`) is exported as a workflow artifact and attached
directly to the GitHub Actions workflow run summary for transparent pipeline visibility.
Verixa's deployment and release pipeline extends Continuous Integration into an automated delivery pipeline:

1. **Conventional Commits & Semantic Versioning:** Commit titles enforce the Conventional Commits specification. When a maintainer runs the manual Semantic release workflow on `main`, `semantic-release` calculates the next semantic version from the commits, tags the repository, and creates a GitHub Release (see [Release Process](release-process.md)).
2. **Container Image Publishing:** Hardened multi-stage Docker builds produce production images tagged by commit SHA (`sha-<short>`), release version (`vX.Y.Z`), and `latest`. Multi-architecture builds (`linux/amd64` and `linux/arm64`) are compiled via Buildx Bake and published to the GitHub Container Registry (`ghcr.io`).
3. **Automated Dependency Updates & Auto-Merge:** Renovate proposes grouped dependency upgrades. Non-breaking patch and minor updates that pass all CI suites and do not touch sensitive security/crypto packages are merged automatically, keeping dependencies current while preserving human review for sensitive updates.
4. **Ephemeral Preview Environments:** Pull requests deploy isolated ephemeral instances of `apps/api` with dedicated backing services. Environments use scoped credentials from the `preview` GitHub Environment and are automatically torn down when the PR is closed or merged.

For a full, end-to-end educational walkthrough of how a commit traverses every stage of the pipeline, see [Building an End-to-End CI/CD Pipeline](tutorials/building-a-cicd-pipeline.md).

## Test Workflow & Coverage Reporting

`.github/workflows/test.yml` separates unit-level test suites with coverage collection from Testcontainers-backed integration tests:

- **`unit-tests` job**: runs `pnpm test:workspace:coverage` to enforce every package's `vitest.config.ts` threshold (Issue 037 and its repeats), then runs `pnpm coverage:ratchet` against `infra/ci/coverage-baseline.json`. The composite action `.github/actions/coverage-report/action.yml` publishes a GitHub Actions check annotation, appends the markdown breakdown to `$GITHUB_STEP_SUMMARY`, and maintains a single sticky comment on pull requests.
- **`integration-tests` job**: omits `TEST_DATABASE_URL` and sets `REQUIRE_DATABASE_TESTS=1`, forcing the database test harness (Issue 047) to spin up an ephemeral Postgres instance via Testcontainers.

### Why Testcontainers in CI?

Mocked unit tests cannot catch SQL constraint mismatches, Prisma migration drift, transaction isolation bugs, or PostgreSQL row-level security (RLS) behavior. Running ephemeral real dependencies in CI catches integration defects before merge without requiring contributors to maintain shared staging databases.

**Rejected alternative:** Mocking Postgres/Redis in the test workflow to speed up CI runs. Rejected because mocks silently drift from real database behavior and give false confidence on repository and session-revocation code.

## Commit Conventions & PR-Title Linting

`.github/workflows/commitlint.yml` enforces the [Conventional Commits](conventional-commits.md) specification (Issue 010) on every pull request in two jobs:

1. **`pr-title`**: validates `github.event.pull_request.title` directly against `commitlint.config.cjs` on `opened`, `edited`, `synchronize`, and `reopened` events. Because GitHub squash-merge defaults the commit message on `main` to the PR title, linting the PR title guarantees that every commit landing on `main` is machine-parseable by `semantic-release` (see [Release Process](release-process.md)).
2. **`commitlint`**: validates every individual commit in the PR branch, catching `--no-verify` bypasses of the local Husky `commit-msg` hook.

**Rejected alternative:** Using a separate regex-based PR-title action with its own duplicated list of allowed commit types. Rejected because two separate type lists inevitably drift; piping the PR title through `pnpm exec commitlint --config commitlint.config.cjs` guarantees one source of truth across local hooks, PR titles, and branch commits.
