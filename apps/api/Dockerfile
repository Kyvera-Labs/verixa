# syntax=docker/dockerfile:1
#
# Build context is the monorepo root (`docker build -f apps/api/Dockerfile .`)
# because pnpm workspaces need the whole workspace — apps/api can't be built
# in isolation from packages/config and packages/shared-kernel.

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

# ---- deps: install the full workspace (dev deps included, needed to build) ----
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/shared-kernel/package.json packages/shared-kernel/package.json
RUN pnpm install --frozen-lockfile

# ---- build: compile apps/api and every package it depends on ----
FROM deps AS build
COPY tsconfig.base.json ./
COPY apps/api apps/api
COPY packages/config packages/config
COPY packages/shared-kernel packages/shared-kernel
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
