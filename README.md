# Verixa

[![CI](https://github.com/Kyvera-Labs/verixa/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Kyvera-Labs/verixa/actions/workflows/ci.yml)
[![Coverage gate](https://github.com/Kyvera-Labs/verixa/actions/workflows/coverage.yml/badge.svg?branch=main)](https://github.com/Kyvera-Labs/verixa/actions/workflows/coverage.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Verixa is open-source infrastructure for **authentication, authorization,
identity, verification, audit logging, security, and governance**, written in
TypeScript. It's built to be read as well as run: every subsystem is a
separately tested package with its design decisions written down next to it.

> **Status: early, and honest about it.** The HTTP API registers users and
> logs them in against Postgres, with password hashing, account lockout,
> role-based authorization and a hash-chained audit log that can be anchored
> to the Stellar testnet. Login does **not** issue a session token yet: the
> sessions package exists but isn't wired into the API. The project is not yet
> open to outside contributions. See the [roadmap](planning/ROADMAP.md).

**Who it's for:** engineers who want to learn how authentication and
authorization systems are built properly (Clean Architecture, DDD, threat
models, tests at every layer) from a codebase you can read end to end, and
teams evaluating it as a base to build on.

**Who it isn't for (yet):** anyone who needs a drop-in, production-hardened
identity provider today. Use an established one; come back when Verixa's
roadmap reaches its launch phase.

## Quickstart

Run the API and one real auth flow in about five minutes. You need
[Node.js](https://nodejs.org/) 22.13+, [pnpm](https://pnpm.io/) 11
(`corepack enable` picks the pinned version), and Docker with Compose.

```bash
git clone https://github.com/Kyvera-Labs/verixa.git
cd verixa
pnpm install
docker compose up -d postgres
pnpm db:wait
export DATABASE_URL=postgres://verixa:verixa@localhost:5432/verixa
pnpm db:migrate:deploy
export SESSION_ACCESS_TOKEN_SECRET="$(openssl rand -base64 48)"
pnpm dev
```

`pnpm install` also generates the Prisma client. Nothing reads a `.env` file,
so two variables are exported: the Prisma CLI needs `DATABASE_URL` (the API
defaults to the same URL), and the API refuses to start without a session
signing secret of at least 32 characters, which has no default on purpose.
`pnpm dev` builds the packages the API depends on and starts it on port 3000.

In a second terminal, register a user, then log in:

```bash
curl -i -X POST http://localhost:3000/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","displayName":"Ada","password":"correct horse battery staple"}'

curl -i -X POST http://localhost:3000/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"correct horse battery staple"}'
```

Registration answers `201 Created` and login `200 OK`, each with the user
(never the password or its hash). Passwords need at least 12 characters. Run
the registration again and it answers `409 Conflict`: the email is taken.

These steps are exactly what [`scripts/quickstart-smoke.sh`](scripts/quickstart-smoke.sh)
runs in CI, from a fresh checkout, on every pull request and every push to
`main`. If this section breaks, the build does too. The OpenAPI document is
served at `http://localhost:3000/docs/openapi.json`.

## Architecture

![Verixa architecture: apps/api wires bounded-context packages, each layered domain, application, infrastructure, on top of the shared kernel, Prisma/Postgres and an optional Stellar anchor](docs/assets/architecture-overview.svg)

Verixa is a pnpm-workspaces monorepo following Clean Architecture and
Domain-Driven Design:

- **`apps/api`** is the only deployable. It's a Fastify app and the
  **composition root**: the one place that chooses concrete adapters and
  wires them into use cases.
- **`packages/*`** hold one bounded context each (identity, credentials, MFA,
  sessions, authorization, audit, verification, notifications, rate
  limiting). Inside each, the **domain** has no framework or database
  imports, the **application** layer defines use cases and the ports they
  need, and **infrastructure** implements those ports. Lint rules enforce
  both the layering and that other packages import only a context's curated
  `index.ts`.
- **Supporting packages:** `shared-kernel` (results, ids, errors), `config`
  (validated environment), `database` (Prisma schema and migrations),
  `stellar-anchor` (anchors the audit log's head hash to Stellar, optional),
  and `testing-kit` (builders, fakes and contract tests, used by tests only).

```
verixa/
├── apps/api/     # Fastify HTTP app, the composition root
├── packages/     # bounded contexts and supporting packages
├── tests/        # cross-package integration and end-to-end suites
├── docs/         # guides, tutorials, ADRs, security design (the docs site)
├── infra/        # CI tooling, Postgres init scripts, deployment config
└── planning/     # roadmap, architecture vision, per-phase issues
```

Why it's built this way, and the alternatives that were rejected:
[`planning/ARCHITECTURE.md`](planning/ARCHITECTURE.md),
[domain modeling](docs/guides/domain-modeling.md), and the
[architecture decision records](docs/adr/0000-adr-process.md).

### A verifiable audit log

Audit entries are hash-chained, so changing one breaks every hash after it.
That alone only helps someone who already holds an earlier hash, because
whoever controls the database can rewrite the whole chain. So Verixa can commit
the chain's head hash to a Stellar transaction, which lets anyone check the
log against a public ledger the operator doesn't control. Only the hash leaves
the database, never audit content. It runs on testnet today. Try it without a
database or any keys (it needs network access to the Stellar testnet):

```bash
pnpm --filter @verixa/audit demo
```

Details: [ADR 0003](docs/adr/0003-stellar-audit-anchoring.md) and the
[Stellar anchoring guide](docs/guides/stellar-anchoring.md).

## Working on Verixa

```bash
pnpm build        # build every workspace package
pnpm typecheck    # typecheck every workspace package
pnpm test         # unit and integration tests (database tests skip without Postgres)
pnpm lint         # ESLint, including the architecture rules
pnpm format       # Prettier
pnpm docs:dev     # browse docs/ as a site at http://localhost:5173
```

## Learn more

The `docs/` folder is a [VitePress](https://vitepress.dev/) site: run
`pnpm docs:dev` to browse it, or read the Markdown on GitHub. Good places to
start:

- [Documentation home](docs/index.md)
- [Testing the platform](docs/guides/tutorials/testing-the-platform.md): unit,
  integration, contract and end-to-end tests, step by step
- Tutorials that build each context, starting with
  [the identity context](docs/guides/tutorials/build-the-identity-context.md)
- [Architecture decision records](docs/adr/0000-adr-process.md)
- Security design: [authentication flows](docs/security/authentication-flows.md)
  and the [threat register](docs/security/threat-register.md)
- [Writing docs](docs/guides/writing-docs.md): how to add a page to the site

## Contributing

Verixa isn't open to outside contributions yet, while the foundations are
being laid. [`CONTRIBUTING.md`](CONTRIBUTING.md) describes the workflow the
maintainers use. To report a vulnerability, see [`SECURITY.md`](SECURITY.md).

## License

[MIT](LICENSE). See [`NOTICE`](NOTICE) for third-party attributions and
[the licensing guide](docs/guides/licensing.md) for why MIT.
