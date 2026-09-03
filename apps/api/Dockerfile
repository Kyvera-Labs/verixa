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

# ---- runtime: minimal image, non-root, only the deployed bundle ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production

# Running as root inside a container is a common, avoidable mistake: a
# container's process namespace isolation is not a security boundary on its
# own, and a container-escape vulnerability (kernel bug, misconfigured
# mount, etc.) hands an attacker root on the host if the process inside was
# already root. A dedicated, unprivileged user costs nothing and closes off
# that entire class of escalation.
RUN addgroup -S verixa && adduser -S verixa -G verixa

WORKDIR /app
COPY --from=build --chown=verixa:verixa /out .

USER verixa
EXPOSE 3000

CMD ["node", "dist/server.js"]
