# syntax=docker/dockerfile:1
#
# Standalone microservice container for @verixa/notifications.
# Implements ARCHITECTURE.md's "service-ready later" bounded context extraction.
# Build context is monorepo root:
#   docker build -f packages/notifications/Dockerfile -t verixa-notifications .
#
# Base image: node:22-alpine
# Pinned image digest: sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a

ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS base
RUN corepack enable
WORKDIR /repo

# ---- deps stage ----
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages packages
COPY apps apps
RUN pnpm install --frozen-lockfile

# ---- build stage ----
FROM deps AS build
COPY tsconfig.base.json ./

RUN pnpm --filter @verixa/notifications... run build
RUN pnpm --filter=@verixa/notifications deploy /out --prod
COPY scripts/prune-runtime-bundle.mjs scripts/
RUN node scripts/prune-runtime-bundle.mjs /out

# ---- production runtime stage ----
FROM ${NODE_IMAGE} AS production
ENV NODE_ENV=production
ENV PORT=3001

RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm \
           /usr/local/bin/npx \
           /usr/local/bin/corepack \
           /usr/local/include/node

RUN addgroup -S -g 10001 verixa && adduser -S -u 10001 -G verixa verixa
WORKDIR /app
COPY --from=build --chown=verixa:verixa /out .

USER verixa
EXPOSE 3001

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3001) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/src/server.js"]

FROM production AS runtime
