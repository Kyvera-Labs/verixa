# ADR-0001: Monorepo layout and core technology stack

## Status

Accepted

## Context

Verixa needs a foundation that supports many independently-testable bounded
contexts (identity, credentials, sessions, authorization, verification, audit,
governance, notifications) that can also be composed into one deployable HTTP
API, while staying approachable for contributors learning backend engineering.

## Decision

- **Monorepo with pnpm workspaces**, split into `apps/*` (deployables) and
  `packages/*` (bounded-context libraries), so each context is its own
  installable, typed, independently testable package.
- **TypeScript in strict mode** everywhere, for compile-time safety and because
  it doubles as documentation for newcomers reading the domain model.
- **Fastify** as the HTTP framework for `apps/api`: schema-first, fast, and
  close enough to plain functions/objects to stay beginner-friendly, unlike
  heavier decorator/DI-based frameworks.
- **PostgreSQL via Prisma** for persistence once introduced (Phase 03):
  generated types keep the domain layer honest, and the schema file doubles as
  living documentation.
- **Vitest** for unit and integration tests, **Supertest** for HTTP-level
  tests, chosen for TypeScript-native speed and a low-friction API.

## Consequences

- Contributors need Node.js + pnpm locally; no other prerequisite for the
  foundational scaffold.
- Package boundaries are enforced by workspace structure and (starting Phase
  02) lint rules against deep imports — internal layering discipline is a
  first-class concern, not an afterthought.
- A modular monolith is easier to reason about for newcomers than
  microservices, while the package boundaries keep the door open to extracting
  services later along the same seams (see `planning/ARCHITECTURE.md` §7 for
  the full alternatives-considered discussion).

## Alternatives Considered

- **Express instead of Fastify** — rejected: no built-in schema validation or
  structure, would require bolting on more third-party pieces than Fastify
  provides out of the box.
- **NestJS instead of Fastify** — rejected: its decorator/DI-heavy model is
  powerful but adds a steep learning curve that works against the
  beginner-friendly educational goal.
- **npm/yarn workspaces instead of pnpm** — rejected: pnpm's content-addressable
  store and stricter dependency resolution catch "phantom dependency" bugs
  that npm/yarn allow silently.
