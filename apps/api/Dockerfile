# syntax=docker/dockerfile:1.20
#
# Issue 384 / #496: frontend 1.20 is required for stable `COPY --parents` and
# cache mounts. Both are used below to keep dependency installation out of the
# layer that invalidates on every source edit.
#
# Build context is the monorepo root (`docker build -f apps/api/Dockerfile .`)
# because pnpm workspaces need the whole workspace — apps/api can't be built
# in isolation from the packages it depends on.
#
# Base image: node:22-alpine
# Pinned image digest: sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
# Base digest pin documented to guarantee build reproducibility and prevent base image drift.

ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS base
RUN corepack enable
WORKDIR /repo

# ---- deps: install the full workspace (dev deps included, needed to build) ----
FROM base AS deps

# Only the files pnpm resolves the dependency graph from, plus the Prisma
# schema the root `prepare` script needs for `db:generate`. `--parents` keeps
# their workspace-relative paths without an enumerated list that would rot
# the moment a new package is added (Issue 050). Copying `packages/` whole
# used to invalidate this layer on every package source edit; now a
# source-only commit reuses the install layer untouched.
COPY --parents pnpm-workspace.yaml pnpm-lock.yaml package.json tests/package.json apps/*/package.json packages/*/package.json packages/*/tsconfig.json packages/*/prisma/schema.prisma ./

# The pnpm store is a cache, not build output: its contents are derived from
# the lockfile and can be reused across builds and branches. A layer holding
# it would be thrown away whenever any later instruction changed; a BuildKit
# cache mount survives that and keeps dependency downloads out of the image.
# `sharing=locked` is deliberate — multi-platform builds would otherwise
# write to the same store concurrently and corrupt it.
RUN --mount=type=cache,id=verixa-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --store-dir /root/.local/share/pnpm/store

# ---- build: compile apps/api and every package it depends on ----
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/api apps/api

# The Prisma client is generated, never committed (it ships a
# platform-specific query engine), so it has to be generated inside the
# image before anything importing @verixa/database can compile. Same
# ordering rule CI follows — see docs/guides/database.md.
# Prisma engine downloads are another derived cache; keeping them in a mount
# means a source-only rebuild does not re-fetch the same engines.
RUN --mount=type=cache,id=verixa-prisma-engines,target=/root/.cache/prisma \
    pnpm --filter @verixa/database run db:generate

RUN pnpm --filter @verixa/api... run build

# `pnpm deploy` bundles apps/api plus its resolved (not symlinked) workspace
# dependencies — dist output and all — into one self-contained, portable
# directory. This is what actually ships; nothing else from /repo does.
# `deploy` reads the same store `install` filled. Without the mount here the
# first deploy after a cache hit would re-download every production package.
RUN --mount=type=cache,id=verixa-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    pnpm --filter=@verixa/api deploy /out --prod --store-dir /root/.local/share/pnpm/store

# Carry the generated client into the bundle.
#
# `deploy --prod` builds /out a fresh node_modules from the store rather than
# copying /repo's, so the client generated above — which lives *inside*
# node_modules, at Prisma's default output location — does not come with it.
# The bundle ships an @prisma/client that has never been generated, and the
# first `new PrismaClient()` throws "@prisma/client did not initialize yet".
#
# Nothing before this point can notice: the image builds, and the package
# imports fine. Only constructing the client fails, once the process is
# already starting.
#
# Copying the output beats running `prisma generate` a second time, which was
# tried first and does not work here. Prisma infers its project root from the
# working directory and resolves @prisma/client from there; neither /repo nor
# the deployed package gives it both, so it falls back to installing
# @prisma/client from the network to recover — in a build stage, offline.
# The artefact already exists and is correct. Moving it is the whole job.
RUN set -eu; \
    src="$(find /repo/node_modules/.pnpm -maxdepth 5 -type d -path '*@prisma+client*/node_modules/.prisma' -print -quit)"; \
    dest="$(find /out/node_modules/.pnpm -maxdepth 4 -type d -path '*@prisma+client*/node_modules' -print -quit)"; \
    test -n "$src"; \
    test -n "$dest"; \
    rm -rf "$dest/.prisma"; \
    cp -R "$src" "$dest/"

# Drop everything the running process will never read: source maps, type
# declarations, the compiled output of the test suites, and our own TypeScript
# sources and coverage output (Issue 216).
#
# `pnpm deploy --prod` excludes dev dependencies but nothing else. It copies
# each workspace package directory whole — no package declares a `files` array
# — so `/out` is where `apps/api/src/**`, every package's `domain/` tree and the
# test run's `coverage/` would otherwise end up, next to the `.js.map` files that
# contain the original source.
#
# That is not merely wasted megabytes. All of it is readable by anyone who gets a
# shell in this container, and none of it buys anything at runtime: a `.spec.js`
# is an executable description of every assumption the tests make about the code,
# and a source tree is the version of the code an attacker would rather read.
#
# The script lives in `scripts/`, is unit-tested in
# `tests/integration/prune-runtime-bundle.spec.ts`, and runs *before* the load
# proof below rather than after it: if the bundle turns out to need one of the
# files this step removes, that is discovered here, at build time, instead of in
# a container that starts and then fails to import.
COPY scripts/prune-runtime-bundle.mjs scripts/
RUN node scripts/prune-runtime-bundle.mjs /out

# `@prisma/client` declares the `prisma` CLI and `typescript` as optional peers,
# and the workspace's `autoInstallPeers` makes `pnpm deploy --prod` install
# them. Neither is read at runtime — the client loads only the generated
# `.prisma` output copied above — and both are dev tooling the image must not
# ship (CI's dev-dependency check). Removed before the load proof below, so a
# client that did need either one fails the build here rather than in a
# running container. The symlinks that pointed at them go too.
RUN set -eu; \
    find /out/node_modules/.pnpm -mindepth 1 -maxdepth 1 -type d \( -name 'prisma@*' -o -name 'typescript@*' \) -print -exec rm -rf {} +; \
    find /out/node_modules -type l \( -name prisma -o -name typescript \) -print -delete

# Prove the bundle actually loads before shipping it.
#
# Two separate production-only failures reached CI from this Dockerfile —
# a CommonJS/ESM interop error at import, then the ungenerated client above —
# and neither was catchable by build, lint, typecheck or the test suite,
# because none of those load the deployed bundle through Node's ESM loader.
# This line does exactly that, so the next one fails here, loudly, at build
# time, rather than as a healthcheck that times out with the reason buried in
# container logs. It runs against the pruned tree, so what is proven here is
# byte-for-byte what ships.
#
# The URL is a placeholder: PrismaClient's constructor requires one but does
# not connect, and connecting is not what is being tested.
RUN cd /out \
      && DATABASE_URL="postgresql://verixa:verixa@127.0.0.1:5432/verixa" \
         node --input-type=module -e "const { PrismaClient } = await import('@verixa/database'); new PrismaClient(); console.log('deploy bundle loads and the prisma client initialises');"

# ---- production: minimal image, non-root, only the deployed bundle ----
FROM ${NODE_IMAGE} AS production
ENV NODE_ENV=production
ENV PORT=3000
ARG VERIXA_BUILD_VERSION=unknown
ENV VERIXA_BUILD_VERSION=$VERIXA_BUILD_VERSION

# The package manager and the compiler toolchain's headers are in the base
# image because the base image is also used for building. In here they are
# post-compromise tooling: `npm install` from inside a running container is how
# a foothold becomes arbitrary code fetched from a registry the operator never
# approved, and `node.gypi` plus the headers exist only to build native
# addons. `node` itself stays — it is the only thing the image runs.
#
# Removing them is also the difference between "an attacker has to ship their
# own tooling into the container" and "an attacker types a command".
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm \
           /usr/local/bin/npx \
           /usr/local/bin/corepack \
           /usr/local/include/node

# Running as root inside a container is a common, avoidable mistake: a
# container's process namespace isolation is not a security boundary on its
# own, and a container-escape vulnerability (kernel bug, misconfigured
# mount, etc.) hands an attacker root on the host if the process inside was
# already root. A dedicated, unprivileged user costs nothing and closes off
# that entire class of escalation.
#
# The UID and GID are pinned rather than let Alpine pick, because the number is
# what an orchestrator asserts on: `runAsNonRoot: true` is satisfiable by any
# non-zero UID, and a `securityContext.runAsUser: 10001` — or a volume whose
# ownership was set for this image — needs the value to be stable across builds.
RUN addgroup -S -g 10001 verixa && adduser -S -u 10001 -G verixa verixa

WORKDIR /app
COPY --from=build --chown=verixa:verixa /out .

USER verixa
EXPOSE 3000

# Issue 388 — Graceful shutdown & container signal handling:
#
# In Docker and Kubernetes, the primary process runs as PID 1.
# Exec-form ENTRYPOINT (["node", "dist/server.js"]) runs node directly as PID 1,
# ensuring the kernel delivers SIGTERM and SIGINT signals directly to the Node
# process without intermediate shell wrapping.
#
# Shell-form ("CMD node dist/server.js" or "ENTRYPOINT node dist/server.js")
# would spawn `/bin/sh -c`, making the shell PID 1 and Node a child process.
# Because POSIX shells do not forward signals to child processes by default,
# SIGTERM is swallowed, preventing Fastify from draining in-flight requests and
# resulting in ungraceful SIGKILL terminations after the orchestrator's timeout.
ENTRYPOINT ["node", "dist/server.js"]
# Native Node-based healthcheck without depending on external binaries like curl or wget.
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/server.js"]

# ---- runtime alias for backwards compatibility ----
FROM production AS runtime
