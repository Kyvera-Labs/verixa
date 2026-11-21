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

For local development with Postgres and Redis, see [Local development
stack](#local-development-stack) below instead.

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
   no monorepo source — just the deployed bundle and a Node runtime. Even the
   base image's `npm`, `npx`, Corepack and Node headers are deleted in this
   stage, and the bundle is pruned of source maps, declarations, compiled
   specs and its own TypeScript sources first.

Only the `runtime` stage ships. Everything in `base`/`deps`/`build` (the
lockfile, every package's source, the TypeScript compiler, `devDependencies`)
exists purely to _produce_ the final image and is discarded — the shipped
image doesn't carry any of it, which keeps it small and reduces its attack
surface (nothing to exploit that was never even in the final layer).

**[docs/security/container-hardening.md](../security/container-hardening.md)
is the security half of this file**: why each removal is there, what the
Trivy gate in `.github/workflows/container-scan.yml` blocks on, and the
measured size and contents of the final image. This file stays about how to
build and run it.

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
with the container logs attached), and then asserts against the running
container:

- `whoami` is not `root`, and `id -u`/`id -g` are not `0` — the name and the
  number, because an orchestrator checks the number;
- `npm`, `npx`, Corepack and the Node headers are not present;
- no `.js.map`, `.d.ts`, `.d.ts.map`, `*.spec.js`, `*.ts` of ours, or
  `coverage/` directory anywhere under `/app`;
- no dev dependency directories under `/app/node_modules`;
- the image size and the file count of `/app` are printed, which is where the
  figures in the hardening doc come from.

This is the same three-part acceptance criteria as the issue that introduced
the Dockerfile — **builds, serves `/health`, doesn't run as root** — verified
as actual behavior, not just "the Dockerfile looks right." The vulnerability
scan of the same image is a separate workflow; see
[docs/security/container-hardening.md](../security/container-hardening.md).

## Local development stack

```bash
docker compose up
```

brings up three containers:

- **`api`** — the API in watch mode (`tsx watch`), source mounted from the
  repo so edits hot-reload without rebuilding a container.
- **`postgres`** — Postgres 16, `verixa`/`verixa`/`verixa` (user/password/db),
  exposed on `5432`.
- **`redis`** — Redis 7, exposed on `6379`.

`docker compose down` stops everything; add `-v` to also drop the named
volumes (Postgres/Redis data, `node_modules`) if you want a fully clean
slate.

### Why `api` doesn't use `apps/api/Dockerfile`

The production image (above) is intentionally minimal: no source, no
TypeScript compiler, no dev dependencies, and it runs pre-built `dist/`
output. None of that supports hot-reload — there's no source in the image to
watch, and rebuilding the image on every save would be far too slow for
inner-loop development. So `docker-compose.yml` instead runs a plain
`node:22-alpine` container with the repo bind-mounted in and `pnpm --filter
@verixa/api run dev` (`tsx watch`) as its command.

This isn't a contradiction of **dev/prod parity** (the [12-factor
app](https://12factor.net/dev-prod-parity) principle that dev and prod
environments should be as similar as possible, to catch environment-specific
bugs before production instead of after) — parity is about _environment_:
same Node version, same OS base image, same Postgres/Redis versions, same
config-via-environment-variables mechanism (`@verixa/config`). All of that is
identical between the compose dev container and the production image. What
differs is _tooling for iteration speed_ — hot-reload vs. a slim artifact —
which 12-factor doesn't ask you to sacrifice; it asks you not to let
_backing services_ (databases, caches, queues) or _runtime versions_ drift
between dev and prod, which this setup deliberately avoids.

### `node_modules` volumes

`docker-compose.yml` gives every `node_modules` directory in the workspace
(root, `apps/api`, `packages/config`, `packages/shared-kernel`) its own named
volume, separate from the bind-mounted source. Two reasons:

1. **Native binaries aren't portable across OS/architecture.** Some
   dependencies (esbuild, used by `tsx` and Vitest) ship platform-specific
   native binaries. A `node_modules` installed on a Windows or macOS host and
   then bind-mounted into a Linux container (or vice versa) will fail at
   runtime with the wrong binary for the platform.
2. **Bind-mounted `node_modules` is slow**, especially on Windows/macOS Docker
   Desktop, where cross-filesystem I/O for tens of thousands of small files
   measurably slows down module resolution and test runs.

### Manual verification checklist

Automated CI coverage for the compose stack itself is deferred (there's no
managed CI runner cost-effective for a long-lived multi-container stack at
this stage) — until then, verify manually after changing
`docker-compose.yml`:

- [ ] `docker compose up` brings up all three containers without exiting/crash-looping
- [ ] `docker compose ps` shows `postgres` and `redis` as `healthy`
- [ ] `curl http://localhost:3000/health` returns `{"status":"ok"}`
- [ ] Editing `apps/api/src/app.ts` (e.g. changing the `/health` response)
      and saving triggers `tsx watch` to reload, visible in
      `docker compose logs -f api`, without restarting the container
- [ ] `docker compose exec api sh -c "nc -zv postgres 5432"` succeeds — the
      API container can reach Postgres by service name
- [ ] `docker compose exec api sh -c "nc -zv redis 6379"` succeeds — the API
      container can reach Redis by service name
- [ ] `docker compose down -v` removes all containers and named volumes cleanly

(Application code doesn't talk to Postgres/Redis yet — that starts in Phase
03 and Phase 05 — so "connects successfully to both" is verified at the
network level for now, via `nc`, not through app behavior.)

## Production build (`apps/api`)

The production build targets `production` in `apps/api/Dockerfile`:

```bash
docker build -f apps/api/Dockerfile --target production -t verixa-api:prod .
```

### Pinned base image digest

The Dockerfile pins the exact SHA256 digest of the base Alpine image:

```dockerfile
# Pinned image digest for node:22-alpine:
# sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS base
```

#### Why digest pinning matters

Docker tags like `node:22-alpine` or even `node:22.13.1-alpine3.21` are mutable references: upstream maintainers routinely rebuild and push new layers under existing tags to patch vulnerabilities or update underlying OS packages. While well-intentioned, this means builds run at different points in time against the exact same commit can pull different underlying binaries.

Pinning by cryptographic hash (`@sha256:...`) ensures:

1. **Bit-for-bit reproducibility:** every CI runner and production deployment builds on the exact same root filesystem layers.
2. **Supply-chain defense:** upstream registry compromise or unintentional tag overwrite cannot inject altered layers into builds.
3. **Auditability:** CVE scanners know the exact base image layer history without ambiguity.

### Pruning devDependencies with `pnpm deploy --prod`

TypeScript, ESLint, Vitest, and associated dev tooling are required to build the monorepo but represent unnecessary bloat and potential security exposure in production.

In stage `build`, we run:

```dockerfile
RUN pnpm --filter=@verixa/api deploy /out --prod
RUN find /out -name "*.map" -type f -delete
```

This constructs a clean, isolated directory `/out` containing only:

- The compiled runtime artifacts (`dist/`) of `apps/api` and its workspace dependencies (`@verixa/shared-kernel`, `@verixa/database`, `@verixa/identity`, etc.)
- Only production `dependencies` resolved into a fresh, isolated `node_modules`
- Zero devDependencies (no compiler, no test runners, no linters)
- Stripped `.map` files (source maps are omitted to reduce final artifact size and prevent internal source layout leakage)

### Built-in HEALTHCHECK

The production image includes an explicit container healthcheck:

```dockerfile
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
```

Using Node 22's built-in `fetch` avoids relying on `curl` or `wget` (which may be omitted in distroless or ultra-minimal Alpine images). Container orchestrators (Docker Compose, Kubernetes, ECS) query this status:

```bash
docker inspect --format='{{json .State.Health.Status}}' <container-id>
```

### Image size comparison

By discarding the build stage (pnpm store, dev dependencies, compilers, source files) and copying only the pruned `/out` bundle, the final `production` runtime container is measurably smaller than the dev/builder stages (typically >65% size reduction).

---

## Extracting a context to its own service

Verixa is built as a **modular monolith** with clean bounded contexts (`packages/*`). Per `ARCHITECTURE.md` §2.6 ("Service-ready later"), the architecture ensures any context can be split into a standalone network microservice with zero changes to domain logic.

To enforce and prove this boundary, `infra/docker/package.Dockerfile.template` provides a reusable parameterized multi-stage Dockerfile for packaging any package in `packages/` into a standalone service.

### Reusable template (`infra/docker/package.Dockerfile.template`)

The template takes three build arguments:

- `PACKAGE_NAME`: the full package specifier (e.g. `@verixa/notifications`)
- `PACKAGE_PATH`: directory path relative to workspace root (e.g. `packages/notifications`)
- `PORT`: default listening port (e.g. `3001`)

```bash
docker build -f infra/docker/package.Dockerfile.template \
  --build-arg PACKAGE_NAME=@verixa/notifications \
  --build-arg PACKAGE_PATH=packages/notifications \
  --build-arg PORT=3001 \
  -t verixa-notifications:latest .
```

### Pilot implementation: `packages/notifications`

`packages/notifications/Dockerfile` implements this standalone pattern for the notifications context:

1. **Self-contained build:** copies workspace manifests and builds only `@verixa/notifications` and its upstream workspace dependencies (`@verixa/shared-kernel`).
2. **Pruned runtime:** runs `pnpm --filter=@verixa/notifications deploy /out --prod` to isolate the package into `/out`.
3. **Dedicated port and healthcheck:** exposes port `3001` and serves `/health` from `packages/notifications/src/server.ts`.
4. **Isolated execution:** runs as unprivileged user `verixa`.

Building and running the isolated notifications service:

```bash
docker build -f packages/notifications/Dockerfile -t verixa-notifications .
docker run -d -p 3001:3001 --name notif verixa-notifications
curl http://localhost:3001/health
# {"status":"ok","service":"notifications"}
```

If a package cannot compile or start in this template, that immediately surfaces a leaky abstraction or hidden circular dependency on another context.

---

## Multi-architecture builds (`amd64` and `arm64`)

Production workloads increasingly run on ARM-based servers (such as AWS Graviton, Ampere Altra) for price-performance benefits, while developers frequently develop on Apple Silicon (M1/M2/M3) or traditional x86-64 workstations. Shipping single-architecture images causes emulation overhead or deployment failures.

### Buildx Bake configuration (`infra/docker/buildx-bake.hcl`)

Verixa uses Docker Buildx Bake to standardize build targets across architectures:

```hcl
group "default" {
  targets = ["api", "notifications"]
}

target "api" {
  context    = "."
  dockerfile = "apps/api/Dockerfile"
  target     = "production"
  platforms  = [
    "linux/amd64",
    "linux/arm64"
  ]
  tags = [
    "ghcr.io/kyvera-labs/verixa-api:latest"
  ]
}
```

### Local multi-arch builds

To build multi-arch images locally with Buildx:

```bash
# Ensure a buildx builder is active
docker buildx create --use --name multiarch-builder

# Build both architectures concurrently using bake
docker buildx bake -f infra/docker/buildx-bake.hcl api
```

### OCI manifest lists in CI

In `.github/workflows/docker-publish.yml`, GitHub Actions runs Buildx with QEMU:

1. `docker/setup-qemu-action@v3` enables emulation for non-native architectures.
2. `docker/setup-buildx-action@v3` configures the builder.
3. `docker/build-push-action@v5` compiles both `linux/amd64` and `linux/arm64` binaries and pushes an **OCI Image Index** (manifest list).

When a client runs `docker pull ghcr.io/kyvera-labs/verixa-api:latest`, the Docker daemon inspects the manifest list and automatically downloads only the layers matching the client host's architecture.
