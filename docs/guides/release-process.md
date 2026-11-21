# Release Process

Verixa's release pipeline turns merged Conventional Commits and package changesets into reproducible, verifiable artifacts with zero manual changelog editing or tag juggling.

This guide covers the three pillars of Phase 19 release automation:

1. **Automated Changelog Generation** (Issue 369 / #481)
2. **GitHub Releases** (Issue 371 / #483)
3. **Per-Package Publishing (Monorepo)** (Issue 370 / #482)

---

## Automated Changelog Generation

`CHANGELOG.md` at the repository root is maintained automatically by `@semantic-release/changelog` and `@semantic-release/git`, configured in [`.releaserc.json`](../../.releaserc.json).

### How It Works

1. Every commit merged to `main` is validated against Conventional Commits by `commitlint` (`.github/workflows/commitlint.yml`).
2. On push to `main`, the `semantic-release` job in `.github/workflows/release.yml` runs:
   - `@semantic-release/commit-analyzer` inspects commits since the last `vX.Y.Z` tag and computes the next semantic version (`feat` → minor, `fix`/`perf`/`revert` → patch, `BREAKING CHANGE` / `!:` → major).
   - `@semantic-release/release-notes-generator` groups commits into **Features**, **Bug Fixes**, **Performance Improvements**, **Reverts**, and **Documentation**, with direct commit and PR links. Internal housekeeping (`chore`, `ci`, `style`, `refactor`, `test`, `build`) is omitted unless it carries a breaking change.
   - `@semantic-release/changelog` prepends the new release section to `CHANGELOG.md`, preserving all existing history below it.
   - `@semantic-release/git` commits `CHANGELOG.md` back to `main` with `[skip ci]` so the release commit does not trigger a recursive pipeline loop.

### Why Automated Changelogs Over Manual Authoring

Changelogs are a byproduct of good commit hygiene. Manual `CHANGELOG.md` editing creates constant merge conflicts on every PR and inevitably drifts from what actually shipped. Because `commitlint` already enforces structured commit messages, generating `CHANGELOG.md` from git history guarantees that every entry matches the exact commits in the release.

---

## GitHub Releases

The `semantic-release` job wires `@semantic-release/github` to publish an atomic GitHub Release for every versioned release.

### Why One Atomic, Traceable Bundle

A release should be a single, discoverable bundle — **git tag + generated release notes + CycloneDX SBOM + Docker image digest** — rather than three loosely-connected side effects a maintainer has to manually reconcile after pushing a tag.

Each GitHub Release automatically includes:

- **Tag**: `vX.Y.Z` created at the exact release commit.
- **Release Notes**: The same grouped, linked notes written to `CHANGELOG.md`.
- **CycloneDX SBOM (`sbom/verixa.cdx.json`)**: Generated and schema-validated from `pnpm-lock.yaml` on the exact commit being released.
- **Docker Image Digest (`release-artifacts/docker-image-digest.txt`)**: Immutable `ghcr.io/kyvera-labs/verixa-api@sha256:...` reference resolved from the container build for that commit.

### Why Draft Releases Never Leak

`semantic-release` executes in strict lifecycle phases (`verifyConditions` → `analyzeCommits` → `generateNotes` → `prepare` → `publish`). `@semantic-release/github` only creates the GitHub Release during `publish`, after SBOM generation, validation, digest resolution, and `CHANGELOG.md` preparation have all succeeded. If any earlier step fails, no tag and no partial/draft release is created — publishing is all-or-nothing.

### Verifying with Dry-Run

You can test the release pipeline safely without creating tags or releases by triggering the **Release** workflow via `workflow_dispatch` with `dry_run: true` (the default).

---

## Per-Package Publishing (Monorepo)

Per `ARCHITECTURE.md` ("composable over monolithic"), each standalone bounded-context package under `packages/*` (`@verixa/identity`, `@verixa/authorization`, `@verixa/rate-limiting`, `@verixa/sessions`, `@verixa/credentials`, `@verixa/audit`, `@verixa/verification`, `@verixa/mfa`, `@verixa/notifications`, `@verixa/config`, `@verixa/shared-kernel`, `@verixa/stellar-anchor`) is versioned and published independently to npm.

Internal workspace packages (`@verixa/api`, `@verixa/database`, `@verixa/integration-tests`, `@verixa/testing-kit`) remain `"private": true` and are listed in `.changeset/config.json`'s `ignore` array.

### Judgement Call: Independent Versioning with Changesets vs. Alternatives

- **Rejected: Lockstep Versioning** — Bumping every `@verixa/*` package to the same version whenever any single package changes creates false churn for consumers. A user depending only on `@verixa/rate-limiting` cannot tell whether a new version actually changed rate-limiting or only touched `@verixa/stellar-anchor`.
- **Rejected: `semantic-release-monorepo` / `multi-semantic-release`** — `semantic-release` was designed for single-package repositories. Multi-package community plugins struggle with pnpm's `workspace:*` protocol rewriting and require complex custom publish scripts to avoid publishing broken `workspace:*` specifiers to npm.
- **Chosen: Changesets (`.changeset/config.json`) + `pnpm -r publish --provenance`** — Changesets has first-class pnpm workspace support, lets contributors declare exact per-package semver intent in their PR, batches pending bumps into a reviewable "Version Packages" PR, and delegates publishing to `pnpm publish`, which natively rewrites `workspace:*` to concrete semver ranges.

### Contributor Workflow for Package Changes

1. Make your changes in one or more `packages/*` directories.
2. Run `pnpm dlx @changesets/cli` and select only the packages you changed, their semver bump (`patch`, `minor`, `major`), and a consumer-facing summary.
3. Commit the generated `.changeset/<random-name>.md` file with your PR.
4. When your PR merges to `main`, `publish-packages` in `.github/workflows/release.yml` opens (or updates) a **Version Packages** PR that bumps _only_ the changed packages. Unrelated packages remain untouched.
5. Merging the **Version Packages** PR publishes _only_ the bumped packages to npm.

### npm Security: Provenance & Automation Token

- **2FA-Safe Automation Token**: Publishing authenticates via `secrets.NPM_TOKEN` (`NODE_AUTH_TOKEN`), which must be an npm **granular access token** (automation/CI type) scoped exclusively to the `@verixa` npm organization — never a personal user token.
- **OIDC Provenance (`--provenance`)**: The `publish-packages` job requests `id-token: write` and runs `pnpm -r publish --access public --provenance --no-git-checks`. Every published tarball carries a cryptographically verifiable Sigstore attestation linking it back to the exact GitHub Actions workflow run and git commit.
- **Manifest Enforcement**: `infra/ci/check-release-config.mjs` verifies that every non-private package under `packages/*` declares `"publishConfig": { "access": "public", "provenance": true }` and points `"main"` and `"types"` at `dist/`.
