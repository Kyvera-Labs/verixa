# Docker

`apps/api/Dockerfile` builds a production image for the API. Because this is
a pnpm workspace — `apps/api` depends on `packages/config` and
`packages/shared-kernel` via `workspace:*` — the build context must be the
**repo root**, not `apps/api/`:

```bash
docker build -f apps/api/Dockerfile -t verixa-api .
docker run -p 3000:3000 verixa-api
curl http://localhost:3000/health
```

(One-command local dev with Postgres/Redis via `docker compose` lands in
Issue 013.)

## Multi-stage build

The Dockerfile has four stages:

1. **`base`** — Node 22 (Alpine) with pnpm enabled via Corepack. Nothing else.
2. **`deps`** — copies only `package.json` files (root + every workspace
   package) and the lockfile, then runs `pnpm install --frozen-lockfile`.
   Docker layer caching means this expensive step is skipped entirely on
   rebuilds where only application code changed, not dependencies.
3. **`build`** — copies the actual source and compiles `apps/api` and its
   workspace dependencies (`pnpm --filter @verixa/api... run build`), then
   runs `pnpm deploy /out --prod` — a pnpm feature purpose-built for this:
   it bundles `apps/api` plus its _resolved_ (real files, not symlinks)
   workspace dependencies — compiled `dist/` included — into one
   self-contained directory. That directory has everything needed to run,
   and nothing else from the monorepo.
4. **`runtime`** — a fresh, minimal `node:22-alpine`, with only `/out` from
   the `build` stage copied in. No pnpm, no TypeScript, no dev dependencies,
   no monorepo source — just the deployed bundle and a Node runtime.

Only the `runtime` stage ships. Everything in `base`/`deps`/`build` (the
lockfile, every package's source, the TypeScript compiler, `devDependencies`)
exists purely to _produce_ the final image and is discarded — the shipped
image doesn't carry any of it, which keeps it small and reduces its attack
surface (nothing to exploit that was never even in the final layer).

## Why the container doesn't run as root

The runtime stage creates and switches to an unprivileged `verixa` user
before `CMD` runs. Containers are **process isolation, not a security
boundary on their own** — if the containerized process is root and an
attacker finds a container-escape vulnerability (a kernel bug, a
misconfigured volume mount, a Docker daemon misconfiguration), they land as
root on the host, not as some unprivileged user. Running as a non-root user
by default costs nothing here and closes off that entire escalation path;
it's one of the most common, easily-avoided container misconfigurations in
real-world deployments.

## Verifying the image in CI

`.github/workflows/ci.yml`'s `docker` job builds the image, starts a
container from it, polls `/health` until it responds (or times out and fails
with the container logs attached), and asserts `docker exec ... whoami`
returns something other than `root`. This is the same three-part acceptance
criteria as the issue that introduced the Dockerfile: **builds, serves
`/health`, doesn't run as root** — verified as actual behavior, not just
"the Dockerfile looks right."
