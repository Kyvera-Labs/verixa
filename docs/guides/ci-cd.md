# CI/CD

## Continuous Integration

`.github/workflows/ci.yml` runs on every push to `master` and every pull
request: install → lint → format check → build → typecheck → test.

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

### Build-before-typecheck ordering

The workflow runs `pnpm build` before `pnpm typecheck`, even though — as it
turns out — TypeScript's module resolution happens to fall back to a
dependency's raw `.ts` source and still typecheck successfully even when
that dependency hasn't been built yet (see
`docs/guides/typescript-conventions.md`). That fallback is real, but relying
on it in CI would be fragile: it's an implementation detail of how
`moduleResolution: "NodeNext"` handles a missing `main`/`types` target, not a
guarantee. `pnpm test`, in particular, does _not_ have this luxury — Vitest
doesn't transform `node_modules` packages, so a test that imports
`@verixa/config` needs its real, built `dist/index.js` to exist, or the test
fails with `ERR_MODULE_NOT_FOUND`. Building first, unconditionally, keeps CI
correct regardless of which check happens to tolerate a missing build and
which doesn't.

### `pnpm` caching

`actions/setup-node`'s `cache: pnpm` step caches the pnpm store keyed on
`pnpm-lock.yaml`, so `pnpm install --frozen-lockfile` is fast on unchanged
dependencies instead of re-downloading the whole dependency tree on every
run.

## Continuous Delivery

Release automation (semantic-release, driven by the Conventional Commits
enforced in Issue 010), Docker image publishing, and deployment pipelines
are covered in Phase 19 and Phase 20 — this document will grow accordingly.
