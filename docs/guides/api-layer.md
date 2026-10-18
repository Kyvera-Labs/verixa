# API Layer: REST and GraphQL

This document outlines the architecture, integration patterns, and operational boundaries of Verixa's API surface in `apps/api`.

---

## 1. Architectural Strategy: Shared Infrastructure, Plural Surfaces

Verixa exposes two complementary API protocols over HTTP:

- **REST**: OpenAPI-first JSON endpoints (`/auth/*`, `/admin/*`, `/verification/*`), tailored for predictable resource interactions, machine-to-machine integrations, and standards-compliant HTTP clients.
- **GraphQL**: Fastify's native GraphQL engine ([Mercurius](https://mercurius.dev/)), mounted at `/graphql`, designed for administrative consoles, complex governance dashboards, and flexible queries across relational graphs.

### Why GraphQL Shares the Existing Process (Single Composition Root)

A common microservices anti-pattern is creating a separate Node.js service for GraphQL while running a distinct service for REST. We rejected that alternative for several reasons:

1. **Unified Observability & Correlation**: Both REST and GraphQL routes share the exact same Fastify instance, Pino structured logger, and request correlation pipeline (`x-request-id` / `x-correlation-id`). Every GraphQL query carries the same correlation identity across audit logs and background jobs as any REST endpoint.
2. **Consistent Security & Route Guards**: Running under a shared composition root guarantees authentication plugins, session resolution hooks, and security headers (CSP, HSTS, X-Frame-Options) apply uniformly across both protocols.
3. **No Domain Duplication**: Resolvers and route handlers call the same underlying use cases instantiated once in `apps/api/src/composition-root.ts`. Neither REST nor GraphQL contains domain logic or direct persistence access.
3. **No Domain Duplication**: Resolvers and route handlers call the same underlying use cases instantiated once in `apps/api/src/composition-root.ts`. Neither REST nor GraphQL contains domain logic.

---

## 2. GraphQL Bootstrap with Mercurius

Mercurius is integrated into the Fastify pipeline in [`apps/api/src/graphql/server.ts`](file:///C:/Users/USER/Gold/verixa/apps/api/src/graphql/server.ts):
Mercurius is integrated into the Fastify pipeline in [`apps/api/src/graphql/server.ts`](file:///C:/DripsWave/verixa/apps/api/src/graphql/server.ts):

```typescript
import mercurius from "mercurius";

export async function registerGraphQLServer(app: FastifyInstance, options = {}): Promise<void> {
  await app.register(mercurius, {
    schema,
    resolvers,
    loaders,
    graphiql: false, // Disabled by default in production
export async function registerGraphQLServer(app: FastifyInstance): Promise<void> {
  await app.register(mercurius, {
    schema,
    resolvers,
    graphiql: false, // Disabled by default in production; enabled conditionally in development
    path: "/graphql",
  });
}
```

---

## 3. Identity & Organization Types (Phase 13 / Issue 243)

The identity domain types (`User`, `Organization`, `OrganizationMembership`) are exposed via GraphQL SDL in `apps/api/src/graphql/schema/identity.graphql`.

### Domain Entity Mapping

Field-level resolvers map domain entities to GraphQL output types:

- **User**: Maps `id`, `email`, `displayName`, `personName` (`givenName`, `familyName`), `status`, `createdAt`, `updatedAt`, `deletedAt`. Soft-deleted users are excluded from standard lookups by the underlying port contract.
- **Organization**: Maps `id`, `name`, `slug`, `ownerId`, `owner`, `status`, `createdAt`, `updatedAt`, `users`, `memberships`.
- **OrganizationMembership**: Represents the first-class join entity linking `User` and `Organization` with `status` (`active` or `revoked`) and `joinedAt`.

### The N+1 Query Problem

In naive GraphQL implementations, relational fields such as `Organization.users` trigger the classic **N+1 query problem**:

1. 1 query is executed to fetch the organization (or a list of $N$ organizations).
2. For each organization, the `users` resolver fires and queries each user or membership individually, generating $N$ additional round trips to the database:
   $$\mathcal{O}(N) \text{ queries for } N \text{ records}$$

#### How Verixa Eliminates N+1

We rejected naive resolver-per-item fetching in favor of **batched use cases and Mercurius loaders**:

1. **Batched Application Use Case**:
   `GetOrganizationUsers` (`packages/identity/application/use-cases/get-organization-users.ts`) queries all memberships for the organization in one call, collects active user IDs, and executes a single `userRepository.findManyByIds(userIds)` query. Resolving all users in an organization takes exactly 2 database round trips, regardless of whether the organization has 2 members or 2,000 members.
2. **AST-Level Batching via Mercurius Loaders**:
   When querying multiple organizations in a single GraphQL request:
   ```graphql
   query {
     organizations {
       id
       name
       users {
         id
         displayName
       }
     }
   }
   ```
   Mercurius loaders (`createIdentityLoaders`) intercept all `Organization.users` calls across the entire query AST tick, bundling them into `GetUsersByOrganizationIds` (`packages/identity/application/use-cases/get-users-by-organization-ids.ts`). This fetches all memberships across all organizations in 1 query, and all users in 1 batch query:
   $$\text{Total DB queries} = 2 \text{ (constant, independent of } N \text{ or } M \text{)}$$

#### Why N+1 Must Be Caught in Tests

Code reviews easily miss N+1 regressions because field resolvers look simple and decoupled in isolation. Verixa enforces N+1 prevention through **query-counting regression tests**:

- Integration tests count the exact number of repository queries executed for nested queries with multiple members.
- Tests assert that expanding the number of members does not increase query count.

---

## 4. Architectural Boundaries: Use Case Enforcement

A fundamental rule across Verixa is that **no GraphQL resolver may bypass an application use case to query a repository or Prisma directly**.

- Resolvers receive `Container` via options or context.
- Reads call focused query use cases (`getUser`, `getOrganization`, `getOrganizationUsers`, `getUserOrganizations`).
- This keeps query validation, tenant boundary checks, and future caching concentrated in the application layer rather than scattered across resolver callbacks.
### Initial Schema & Gateway Layer

Phase 13 introduces GraphQL as an entry point with a foundational schema:

```graphql
type Query {
  _service: String!
}
```

Standard queries such as `{ __typename }` and introspection are handled natively by Mercurius. As Phase 13 progresses, resolvers wrap domain use cases to support granular governance queries, complexity analysis, and depth limiting.

---

## 3. Operational Guarantees & Testing

1. **Liveness & Independence**: The health endpoint (`GET /health`) remains an independent probe that does not depend on database or GraphQL schema compilation.
2. **Correlation Header Propagation**: All responses from `/graphql` propagate incoming or generated correlation IDs (`x-correlation-id` / `x-request-id`), matching REST endpoints.
3. **Automated Verification**: Verified via automated integration tests in [`apps/api/src/graphql/server.spec.ts`](file:///C:/DripsWave/verixa/apps/api/src/graphql/server.spec.ts).
