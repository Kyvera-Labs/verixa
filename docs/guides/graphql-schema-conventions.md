# GraphQL Schema Conventions & Design Principles

This document establishes the schema design principles, naming conventions, and boundary policies governing Verixa's GraphQL surface (`/graphql`) introduced in Phase 13.

---

## 1. Schema-First Design (SDL-First Contract)

In Verixa, GraphQL schemas are authored as `.graphql` Schema Definition Language (SDL) files in `apps/api/graphql/`.

They live outside `src/` for the same reason `apps/api/openapi/` does: `tsc` copies only TypeScript into `dist/`, so a schema file under `src/` is missing when the built server starts. `graphql/server.ts` reads them with a path that resolves to this folder from both `src/` and `dist/`. (Older planning issues name `apps/api/src/graphql/schema/`; use `apps/api/graphql/` instead.)

### Why Schema-First Over Code-First

We evaluated two approaches for constructing our GraphQL surface:

1. **Code-First** (e.g. TypeGraphQL, Nexus, or programmatic schema building).
2. **Schema-First (SDL)** (standard `.graphql` files compiled at startup with Mercurius).

**Decision:** We adopted schema-first design using standard SDL files.

**Rationale:**

- **The Contract Is Negotiated Before Implementation**: In code-first approaches, the GraphQL schema is an implicit side effect of TypeScript decorator annotations or builder calls, frequently drifting during refactors. In schema-first design, the SDL is a deliberate, reviewable contract that domain experts and frontend engineers can inspect and diff directly.
- **Tooling & Interoperability**: Standard `.graphql` files are natively consumed by GraphQL schema linters, schema diff tools, Apollo Studio, and codegen pipelines without executing Node.js application code.
- **Separation of Contract and Resolver**: Keeping schema files separate from resolvers enforces the hexagonal architecture rule that transport representations are independent of resolver implementations.

---

## 2. Naming Conventions

Verixa enforces strict naming conventions across all SDL definitions:

| Element                 | Casing       | Example                                                | Notes                                                                  |
| :---------------------- | :----------- | :----------------------------------------------------- | :--------------------------------------------------------------------- |
| **Object Types**        | `PascalCase` | `User`, `Organization`, `OrganizationMembership`       | Singular nouns representing domain aggregates or entities              |
| **Interfaces / Unions** | `PascalCase` | `Node`, `AuditSubject`                                 | Descriptive category names                                             |
| **Fields**              | `camelCase`  | `displayName`, `ownerId`, `joinedAt`                   | Verbs for mutations, nouns for queries                                 |
| **Field Arguments**     | `camelCase`  | `(id: ID!)`, `(organizationId: ID!)`                   | Explicit, typed arguments                                              |
| **Enum Types**          | `PascalCase` | `UserStatus`, `OrganizationStatus`, `MembershipStatus` | Singular nouns                                                         |
| **Enum Values**         | `lowercase`  | `pending`, `active`, `suspended`, `deleted`            | **Matches domain string unions directly**, avoiding translation layers |
| **Directives**          | `camelCase`  | `@requiresPermission`                                  | Declarative field decorators                                           |

### Why Enum Values Mirror Domain Lowercase Unions

In standard GraphQL style guides, enum values are often `SCREAMING_SNAKE_CASE` (e.g. `PENDING`, `ACTIVE`).

**Alternative Rejected:** We rejected `SCREAMING_SNAKE_CASE` enums in favor of exact lowercase strings matching the domain types (`UserStatus = "pending" | "active" | "suspended" | "deleted"`).

**Rationale:**
Transforming between `ACTIVE` on the wire and `"active"` in domain entities requires boilerplate mapping functions in every resolver and input handler. Because the domain unions are already closed sets verified by TypeScript and database enum constraints, aligning GraphQL enums directly with the domain removes an entire class of mapping bugs with zero loss of type safety.

---

## 3. Root Operations & Schema Organization

The schema is partitioned into modular `.graphql` files loaded by the GraphQL bootstrap engine:

- `root.graphql`: Declares the base `type Query` and `type Mutation`.
- `identity.graphql`: Declares `User`, `Organization`, `OrganizationMembership`, and extends `Query`.
- Subsequent issues add `authorization.graphql`, `verification.graphql`, and `audit.graphql` via `extend type Query` and `extend type Mutation`.

```graphql
type Query {
  _service: String!
}

type Mutation {
  _empty: String
}
```

The `_service` field on `Query` serves as an unauthenticated liveness and service-discovery probe.

---

## 4. REST vs. GraphQL Inclusion Policy

Verixa maintains both REST (Phase 12) and GraphQL (Phase 13) interfaces side by side on the same Fastify server. GraphQL is **not** a wholesale replacement for REST. Every new capability must adhere to the following inclusion criteria:

### When to Expose via REST (Issues 221–240)

- **Machine-to-Machine & Webhooks**: Inter-service webhooks, ingestion endpoints, and automated background sync.
- **Authentication Handshakes & Session Lifecycle**: Login (`/auth/login`), registration (`/auth/register`), password reset, and token refresh. These require predictable cookie manipulation, redirect semantics, and standard HTTP status codes (e.g., 401, 403, 429).
- **Binary & Media Streaming**: File uploads (KYC evidence documents), cryptographic key exports, and large CSV audit downloads.
- **Edge Caching**: Public resources benefiting from HTTP cache-control and CDN edge caching.

### When to Expose via GraphQL (Issues 241–260)

- **Admin Console & Governance Dashboards**: Administrative views needing nested entities in a single round trip (e.g., Organization → Members → Roles).
- **Flexible Relational Queries**: Client-driven field selection that prevents over-fetching on high-latency or mobile networks.
- **Compound Permission & Verification Workflows**: Complex review queues and effective-permission queries where composing multiple REST round trips would be costly.

---

## 5. Architectural Invariant: Resolvers Are Thin Adapters

Resolvers follow the exact same architectural contract as REST route handlers:

1. **No Business Logic**: Resolvers orchestrate domain calls; they never implement domain rules.
2. **No Repository Access**: Resolvers call use cases instantiated on `Container`; they never import Prisma or touch repositories directly.
3. **Shape Translation Only**: Resolvers translate domain aggregate entities into GraphQL presentation shapes and format ISO-8601 timestamps.
