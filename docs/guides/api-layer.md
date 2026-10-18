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
3. **No Domain Duplication**: Resolvers and route handlers call the same underlying use cases instantiated once in `apps/api/src/composition-root.ts`. Neither REST nor GraphQL contains domain logic.

---

## 2. GraphQL Bootstrap with Mercurius

Mercurius is integrated into the Fastify pipeline in [`apps/api/src/graphql/server.ts`](file:///C:/DripsWave/verixa/apps/api/src/graphql/server.ts):

```typescript
import mercurius from "mercurius";

export async function registerGraphQLServer(app: FastifyInstance): Promise<void> {
  await app.register(mercurius, {
    schema,
    resolvers,
    graphiql: false, // Disabled by default in production; enabled conditionally in development
    path: "/graphql",
  });
}
```

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
