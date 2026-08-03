# Verixa

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Verixa is open-source infrastructure for **authentication, authorization,
identity, verification, audit logging, security, and governance** — built to be
production-ready and, at the same time, a complete educational resource for
learning backend engineering, software architecture, and security best practices.

Every subsystem (credentials, sessions, RBAC, audit logging, etc.) is designed as
an independently testable, independently reusable module under `packages/`,
composed together by the HTTP API in `apps/api`.

> **Status:** early scaffold. Only foundational tooling exists so far — see
> [Roadmap](#roadmap) below.

## Why Verixa

Most auth/identity building blocks are either a SaaS you pay for and can't audit,
or a snippet you copy-paste and never fully understand. Verixa aims to be neither:
a codebase you can read end to end, run yourself, and learn real architecture and
security practice from — while still being solid enough to build on.

## Architecture

Verixa is a TypeScript pnpm-workspaces monorepo following Clean Architecture and
Domain-Driven Design: domain logic has no dependency on frameworks or databases,
and each bounded context (identity, credentials, sessions, authorization,
verification, audit, governance, notifications) lives in its own package.

Full details: [`docs/adr/0001-monorepo-and-stack.md`](docs/adr/0001-monorepo-and-stack.md)
records the stack decision; a broader architecture guide will grow under `docs/`
as more contexts are built.

```
verixa/
├── apps/api/        # Fastify HTTP app (composition root)
├── packages/        # Bounded-context packages (domain/application/infrastructure/interface)
├── infra/           # Deployment & infrastructure config
├── docs/            # Guides, ADRs, tutorials
└── tests/           # Cross-package integration/e2e tests
```

## Prerequisites

- [Node.js](https://nodejs.org/) 22.13 or later (required by pnpm 11)
- [pnpm](https://pnpm.io/) 11 or later (`npm install -g pnpm`)

## Quickstart

```bash
pnpm install
pnpm --filter @verixa/api dev
```

The API starts on `http://localhost:3000` (override with `PORT`). Verify it's up:

```bash
curl http://localhost:3000/health
# {"status":"ok"}
```

Prefer one command and don't want Node/pnpm installed locally at all? Run the
full stack (API + Postgres + Redis) in Docker instead:

```bash
docker compose up
```

See [`docs/guides/docker.md`](docs/guides/docker.md) for details, including
the production image (`apps/api/Dockerfile`), which is a separate,
intentionally different thing from the dev compose stack.

Other useful commands, run from the repo root:

```bash
pnpm build       # build all workspace packages
pnpm typecheck   # typecheck all workspace packages
pnpm test        # run all unit/integration tests
pnpm lint        # lint the whole workspace
pnpm format      # auto-fix formatting with Prettier
```

See [`docs/guides/code-style.md`](docs/guides/code-style.md) for what the
linter checks and why.

## Contributing

Verixa isn't yet open for external contribution — the initial architecture and
foundational tooling are still being laid down. See
[`CONTRIBUTING.md`](CONTRIBUTING.md) for the local developer workflow so far.
A `CODE_OF_CONDUCT.md` and issue/PR templates will land as part of the
roadmap before the project accepts outside contributions.

## License

[MIT](LICENSE)
