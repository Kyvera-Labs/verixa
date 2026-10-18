# syntax=docker/dockerfile:1
#
# Build context is the monorepo root (`docker build -f apps/api/Dockerfile .`)
# because pnpm workspaces need the whole workspace — apps/api can't be built
# in isolation from the packages it depends on.

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

# ---- deps: install the full workspace (dev deps included, needed to build) ----
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/api/package.json apps/api/package.json
# Every package manifest, not an enumerated subset. An explicit list is
# better for layer caching but silently breaks the build the moment a new
# workspace dependency is added — which is exactly what happened when
# apps/api gained @verixa/database and @verixa/identity (Issue 050): the
# image failed with "Cannot find module" while every other check passed.
# Copying the manifests wholesale trades a little cache granularity for a
# build that can't rot out of sync with the dependency graph.
COPY packages packages
RUN pnpm install --frozen-lockfile

# ---- build: compile apps/api and every package it depends on ----
FROM deps AS build
COPY tsconfig.base.json ./
COPY apps/api apps/api

# The Prisma client is generated, never committed (it ships a
# platform-specific query engine), so it has to be generated inside the
# image before anything importing @verixa/database can compile. Same
# ordering rule CI follows — see docs/guides/database.md.
RUN pnpm --filter @verixa/database run db:generate

RUN pnpm --filter @verixa/api... run build

# `pnpm deploy` bundles apps/api plus its resolved (not symlinked) workspace
# dependencies — dist output and all — into one self-contained, portable
# directory. This is what actually ships; nothing else from /repo does.
RUN pnpm --filter=@verixa/api deploy /out --prod

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

# ---- runtime: minimal image, non-root, only the deployed bundle ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production

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

CMD ["node", "dist/server.js"]
