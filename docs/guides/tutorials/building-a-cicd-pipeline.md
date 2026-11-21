# Building an End-to-End CI/CD Pipeline (Verixa Phase 19 Walkthrough)

How a commit in the Verixa monorepo becomes an audited, tested, versioned, containerized release running in staging and production — and why each automation layer is structured the way it is.

## Overview

In a production-grade infrastructure platform, CI/CD is not simply a script that runs tests. It is an end-to-end chain of trust. Every change must be validated against style, static types, unit contracts, live persistence boundaries, security vulnerability databases, container sanity checks, and semantic versioning rules before touching production.

This tutorial walks through the entire pipeline by tracing one hypothetical commit through each stage:

```text
git commit (Conventional Commit format)
   │
   ▼
[Stage 1] Local Pre-commit Hook & Commit Linting
   │
   ▼
[Stage 2] Matrix Install & pnpm Store Cache
   │
   ▼
[Stage 3] Build-First Monorepo Compilation
   │
   ▼
[Stage 4] Parallel Verification Gates (Lint, Typecheck, Test, Coverage)
   │
   ▼
[Stage 5] Ephemeral Infrastructure Tests (Testcontainers & Compose Roles)
   │
   ▼
[Stage 6] Static Analysis & Supply Chain Scanning (CodeQL, osv-scanner)
   │
   ▼
[Stage 7] PR Ephemeral Preview Deployment & Teardown
   │
   ▼
[Stage 8] Merge to Master & Semantic-Release (Changelog, Tags, GitHub Release)
   │
   ▼
[Stage 9] Independent Multi-Package & Container Publishing (ghcr.io)
   │
   ▼
[Stage 10] Automated Dependency Maintenance & Safe Auto-Merge
```

---

## The Walkthrough: A Single Commit's Journey

To keep the narrative concrete, we follow this hypothetical commit:

```git
commit 8f2a1b9c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a
Author: Ohiomah deborah <deborahohiomah@gmail.com>
Date:   Thu Nov 19 12:00:00 2026

feat(identity): add organization domain event on membership revocation

Emits OrganizationMembershipRevoked when a member is removed from an
organization, enabling audit logging to record tenant boundary changes.
```

---

## Stage 1: Commit Hygiene & Local Gates

Before the commit can even be recorded locally, two gates fire:

1. **Conventional Commits Format (`commitlint`):**
   - Configured in `commitlint.config.js` and enforced via Husky in `.husky/commit-msg` (Issue 010, Issue 367).
   - Conventional Commits (`type(scope): subject`) turn commit logs into machine-readable structured data.
   - Without this, automated version bumping (`semantic-release`, Issue 368) is impossible because machines cannot infer semantic intent from freeform text like "fix stuff" or "updated code".

2. **Pre-commit Linter & Formatter (`lint-staged`):**
   - Configured in root `package.json` and `.husky/pre-commit` (Issue 009).
   - Runs `eslint --fix` and `prettier --write` against staged files only.
   - _Design Decision — Hooks are advisory, not authoritative:_ Pre-commit hooks can be bypassed with `--no-verify`. Therefore, CI never assumes git hooks ran; it re-executes all checks authoritatively.

---

## Stage 2: Monorepo Foundation, Matrix & Caching

When pushed to a pull request, `.github/workflows/ci.yml` triggers on GitHub Actions (Issue 361).

### Deterministic pnpm Workspace Caching

Re-installing hundreds of megabytes of npm packages on every push wastes compute and slows PR feedback cycles.

```yaml
- uses: pnpm/action-setup@v4
- uses: actions/setup-node@v4
  with:
    node-version: 22
    cache: pnpm
```

#### Why cache by lockfile hash instead of branch name?

Caching keyed on branch names leads to **cache poisoning**: if branch `feature-A` tests a bad or corrupt package version, subsequent runs on that branch inherit the poison.

Keying the cache strictly on `pnpm-lock.yaml` ensures that:

- Two jobs with identical lockfiles share the exact same store.
- Any edit to `pnpm-lock.yaml` automatically creates an isolated, fresh cache key.
- A lockfile drift check (`pnpm install --frozen-lockfile`) guarantees no unexpected dependencies creep into CI.

---

## Stage 3: The Build-First Ordering Principle

Before running linting, formatting checks, or test suites, CI executes:

```yaml
- name: Generate Prisma client
  run: pnpm db:generate

- name: Build
  run: pnpm build

- name: Re-link workspace packages
  run: pnpm install --frozen-lockfile
```

### Why compile before linting?

In a TypeScript monorepo using standard `"exports"` in `package.json` (such as `apps/api` exporting `./app`), Node and ESLint type resolvers look for built definition files (`dist/app.d.ts`).

If dependencies are not compiled prior to running ESLint:

1. TypeScript import resolvers fail to find `dist/` subpaths.
2. ESLint's type-aware rules fall back to evaluating unresolvable types as `any`.
3. Cascading spurious errors (such as `no-unsafe-assignment` or `no-unsafe-call`) flood the logs on lines that are completely valid code.

Building first, unconditionally, ensures all subsequent checks operate on real type declarations.

---

## Stage 4: Parallel Quality Gates

With workspace artifacts built, CI executes the verification matrix (Issue 362, Issue 363):

1. **Prisma Schema Validation & Drift Detection:**

   ```bash
   pnpm --filter @verixa/database run db:validate
   pnpm --filter @verixa/database run db:format:check
   pnpm --filter @verixa/database run db:drift
   ```

   _Why this matters:_ If a developer edits `schema.prisma` without generating a migration SQL file, their local code might compile, but production (which runs migrations only) will break. Drift detection replays all migrations into an ephemeral shadow database and diffs the resulting schema against `schema.prisma`.

2. **Linting and Format Enforcement:**

   ```bash
   pnpm lint
   pnpm format:check
   ```

   Enforces architectural boundaries:
   - Disallows circular package references.
   - Prevents domain entities from importing infrastructure libraries (like Prisma or Fastify).
   - Verifies code style via Prettier.

3. **Typechecking Across All Workspaces:**

   ```bash
   pnpm typecheck
   ```

   Runs `tsc --noEmit` in strict mode across root and packages.

4. **Unit & Contract Testing with Coverage Floor:**
   ```bash
   pnpm test
   pnpm --filter @verixa/identity run test:coverage
   ```
   Vitest runs all test suites. For critical domain packages (`@verixa/identity`), strict coverage thresholds (statements ≥90%, branches ≥85%) fail the build if a PR introduces untested paths.

---

## Stage 5: Ephemeral Infrastructure Testing

Unit tests with in-memory mocks verify business logic, but they structurally cannot test real database behavior (locking, transactions, unique constraint violations, foreign key cascades, and row-level security).

Verixa uses two real database strategies in CI:

### 1. Service Container Integration (`ci` job)

GitHub Actions provisions a real PostgreSQL 16 Alpine container directly attached to the workflow network:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    env:
      POSTGRES_USER: verixa
      POSTGRES_PASSWORD: verixa
      POSTGRES_DB: verixa_test
    ports:
      - 5432:5432
```

`REQUIRE_DATABASE_TESTS=1` forces database-backed tests to fail loudly if PostgreSQL is unreachable, rather than silently skipping.

### 2. Testcontainers Isolation (`testcontainers` job)

To verify that contributors without a persistent PostgreSQL service can still run tests locally, the `testcontainers` job deliberately unsets `TEST_DATABASE_URL` (Issue 047). The integration harness spins up ephemeral Testcontainers on demand via Docker and executes repository contract tests against it.

### 3. Compose Database Roles & RLS Verification (`compose-database-roles` job)

A PostgreSQL superuser unconditionally bypasses Row-Level Security (RLS). If `apps/api` were to connect as `verixa` (superuser), tenant isolation would fail silently.

The CI workflow verifies:

- `docker compose up -d postgres` runs initialization scripts in `infra/postgres/`.
- The application connects as `verixa_app`.
- PostgreSQL system catalogs confirm `verixa_app` is `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`.
- Cross-tenant writes without tenant context are rejected by RLS.

---

## Stage 6: Security & Supply Chain Scanning

Security is treated as a continuous automated gate (Issue 364, Issue 374):

1. **Dependency Audit (`pnpm audit --prod` / `osv-scanner`):**
   Scans dependency manifests against known CVE databases. Differentiates between development dependencies and production runtime dependencies to prevent false positives from build tools while blocking known vulnerabilities in shipped code.
2. **Static Application Security Testing (CodeQL):**
   Analyzes dataflow graphs across route handlers and composition roots, catching injection vulnerabilities, timing leaks, and insecure cryptographic usage.
3. **Lockfile Integrity:**
   `pnpm install --frozen-lockfile` ensures `pnpm-lock.yaml` is never out of sync with `package.json`.

---

## Stage 7: Ephemeral Pull Request Preview Environments

For reviewers to inspect changes in a live environment, `.github/workflows/preview-deploy.yml` triggers on PR synchronization (Issue 375, Issue 376, Issue 377):

1. **Container Build:** Builds `apps/api` using the production target.
2. **Ephemeral Provisioning:** Launches an isolated instance of the API alongside PostgreSQL and Redis in an ephemeral namespace keyed by PR number (e.g. `pr-492.preview.verixa.internal`).
3. **Secrets Isolation:** Preview environments pull credentials exclusively from the `preview` GitHub Environment. Forks cannot access production secrets.
4. **Teardown Automation:** When the PR is closed or merged, `.github/workflows/preview-teardown.yml` tears down all containers and volumes. A periodic scheduled sweep (`preview-sweep.yml`) cleans up abandoned resources.

---

## Stage 8: Merge to Master & Automated Release

Once all checks pass and the PR is approved, it is squashed and merged to `master`.

This immediately triggers `.github/workflows/release.yml` powered by `semantic-release` (Issues 368, 369, 370, 371):

1. **Commit Analyzer:** Parses commit headers since the last tag.
   - `feat(...)` triggers a **minor** version bump (e.g. `0.1.0` -> `0.2.0`).
   - `fix(...)` triggers a **patch** version bump.
   - `BREAKING CHANGE:` or `feat(...): ...!` triggers a **major** version bump.
2. **Release Notes & Changelog Generator:**
   - Automatically populates `CHANGELOG.md` with grouped features, bug fixes, and links to commits and PRs.
   - Commits the updated changelog back to `master`.
3. **GitHub Release:** Creates a signed Git tag and publishes a GitHub Release containing release notes and asset checksums.

---

## Stage 9: Multi-Architecture Container Publishing

Following release creation, `.github/workflows/docker-publish.yml` executes (Issues 365, 381, 383):

1. **QEMU & Docker Buildx Initialization:**
   Sets up QEMU emulation for `linux/amd64` and `linux/arm64`.
2. **Multi-Arch Compilation via Buildx Bake:**
   Executes `docker buildx bake -f infra/docker/buildx-bake.hcl` to build the hardened `production` target for both architectures.
3. **OCI Manifest List Publication:**
   Pushes the multi-architecture image to GitHub Container Registry (`ghcr.io/kyvera-labs/verixa-api`):
   - `ghcr.io/kyvera-labs/verixa-api:sha-<short>` (immutable commit digest)
   - `ghcr.io/kyvera-labs/verixa-api:v0.2.0` (version release tag)
   - `ghcr.io/kyvera-labs/verixa-api:latest` (master tracking tag)

---

## Stage 10: Automated Dependency Updates & Auto-Merge

Keeping dependencies up to date is automated via Renovate (Issues 372, 373):

- **Grouped PRs:** Monorepo dependencies are updated together to maintain lockfile coherence.
- **Conventional Commits:** Renovate formats PR titles following Conventional Commits (e.g. `chore(deps): update fastify to v5.12.2`).
- **Safe Auto-Merge Policy (`.github/workflows/auto-merge.yml`):**
  - Patch and minor updates that pass all CI stages and do not touch security-sensitive packages (such as `@stellar/stellar-sdk`, `argon2`, or `@verixa/credentials`) are auto-approved and merged.
  - Major version updates and security-sensitive packages always require manual review.

---

## Summary of Real Workflow Files in the Repository

| Workflow File                              | Purpose                                                                                                      | Phase Issues       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------ |
| `.github/workflows/ci.yml`                 | Full validation: build, lint, typecheck, unit/integration tests, testcontainers, compose roles, Docker smoke | 361, 362, 363, 047 |
| `.github/workflows/docker-publish.yml`     | Multi-architecture (`amd64`/`arm64`) image build and publication to GHCR via Buildx Bake                     | 365, 381, 383      |
| `.github/workflows/docker-build.yml`       | Base container build verification on pull requests                                                           | 365                |
| `infra/docker/buildx-bake.hcl`             | Declarative Buildx Bake specification for API and standalone context services                                | 383                |
| `infra/docker/package.Dockerfile.template` | Reusable multi-stage template for extracting any bounded context into a standalone container                 | 382                |
| `apps/api/Dockerfile`                      | Production-hardened multi-stage container with pinned digest, pruned devDeps, and HEALTHCHECK                | 012, 381           |
| `packages/notifications/Dockerfile`        | Standalone pilot container service for `@verixa/notifications`                                               | 382                |

By combining deterministic caching, build-first sequencing, live integration testing, isolated preview environments, and semantic-release automation, the Phase 19 pipeline ensures that every commit is verified before merge and seamlessly deployed upon arrival.
