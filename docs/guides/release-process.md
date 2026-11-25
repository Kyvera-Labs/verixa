# Release Process

Verixa uses [`semantic-release`](https://semantic-release.gitbook.io/) configured in `.releaserc.json` and executed by `.github/workflows/semantic-release.yml` to automate versioning, git tagging, and GitHub Release creation.

## Cutting a release

Releases are **manual**: a maintainer runs **Actions -> Semantic release -> Run workflow** on `main`. The `dry_run` input defaults to on, so the first run only prints the computed version and notes; run it again with `dry_run` off to publish.

It does not run on every push to `main`. That would publish a release for every merge, and since `deploy.yml` follows the `Release` workflow, it would also try to deploy each one. semantic-release and its plugins are root devDependencies installed from the lockfile, not fetched with `npx`, so they pass the same supply-chain checks as everything else.

## Semantic Versioning as a Communication Contract

Semantic Versioning (`MAJOR.MINOR.PATCH`) is a contract with downstream consumers, not an arbitrary counter. Deriving version bumps deterministically from [Conventional Commits](conventional-commits.md) keeps that contract honest at scale because no human has to guess whether a batch of commits contains a breaking change or a feature:

| Commit header / footer                                             | Release bump    | Example            |
| ------------------------------------------------------------------ | --------------- | ------------------ |
| `fix:`, `perf:`, `revert:`                                         | Patch (`0.0.x`) | `1.2.3` -> `1.2.4` |
| `feat:`                                                            | Minor (`0.x.0`) | `1.2.3` -> `1.3.0` |
| `feat!:`, `fix!:`, or `BREAKING CHANGE:` footer                    | Major (`x.0.0`) | `1.2.3` -> `2.0.0` |
| `docs:`, `chore:`, `test:`, `refactor:`, `ci:`, `build:`, `style:` | No release      | —                  |

## Configuration

`.releaserc.json` configures three plugins on the `main` branch:

1. **`@semantic-release/commit-analyzer`** (`conventionalcommits` preset): inspects commits since the last tag and determines the next bump (`major`, `minor`, `patch`, or none).
2. **`@semantic-release/release-notes-generator`** (`conventionalcommits` preset): generates structured release notes grouped by commit type.
3. **`@semantic-release/github`**: creates the annotated git tag (`vX.Y.Z`) and publishes the GitHub Release.

When a maintainer pushes the tag `vX.Y.Z`, the `sbom` job in `.github/workflows/release.yml` generates and attaches the CycloneDX SBOM for that exact locked commit. A tag created by the Semantic release workflow uses its `GITHUB_TOKEN`, which by GitHub design does not start other workflows, so to attach the SBOM, re-push that tag from a maintainer account (`git push origin :refs/tags/vX.Y.Z && git push origin vX.Y.Z` after fetching it).

## Dry-Run Verification

To preview what `semantic-release` would compute without tagging or publishing:

```bash
pnpm run release:dry-run
```

On a fixture commit history containing `fix:`, `feat:`, and `feat!:` / `BREAKING CHANGE:` commits, `--dry-run` prints the analyzed commits, the computed next version, and the generated release notes without mutating git tags or GitHub state.

## Why `semantic-release` (and Rejected Alternatives)

- **Rejected alternative: manual `npm version` / hand-edited changelogs.** Manual bumps are error-prone, easily forgotten under time pressure, and decouple the version number from the actual commit history.
- **Rejected alternative: Changesets.** While Changesets works well for independently published npm libraries, Verixa ships as a unified platform release from `main` where PR titles are already enforced as Conventional Commits by `.github/workflows/commitlint.yml`. Requiring a separate changeset markdown file per PR adds contributor friction without adding signal.
