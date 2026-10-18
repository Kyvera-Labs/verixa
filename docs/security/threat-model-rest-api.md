# REST API Threat Model and Security Review

This document defines the threat model for Verixa's REST API layer (`apps/api`), evaluating security boundaries, threats across the STRIDE methodology, mitigations implemented in code, and concrete verification tests.

Verixa is security infrastructure. The API layer is the public perimeter through which all external actors—authenticated users, administrators, automated machine clients, and unauthenticated attackers—interact with identity, authentication, session, verification, and authorization domains.

---

## 1. System Model and Trust Boundaries

The REST API layer exposes domain use cases over HTTP using Fastify. It maintains a strict separation of concerns:

- **Routing & Serialization Layer (`apps/api/src/routes`)**: Translates HTTP request bodies, parameters, and headers into strongly typed domain use-case inputs, and maps use-case results to standard HTTP responses. Contains no domain or business logic.
- **Cross-Cutting Pipeline (`apps/api/src/plugins`)**: Request correlation tracking (`request-id`), security header injection (`helmet`), authentication verification (`preHandler`), role/permission enforcement guards, and error formatting.
- **Composition Root (`apps/api/src/composition-root.ts`)**: Wires infrastructure implementations (repositories, token signers, hashers, rate limiters) to use cases.

### Trust Boundaries

1. **External Client $\leftrightarrow$ Fastify HTTP Server**: Completely untrusted boundary. All inbound payloads, query parameters, path variables, and HTTP headers are assumed hostile.
2. **Fastify Route Handler $\leftrightarrow$ Application Use Case**: Validated boundary. Requests crossing into domain use cases must conform to validated schemas and authenticated principal contexts.
3. **Application Use Case $\leftrightarrow$ Persistence / Infrastructure**: Trusted internal boundary. Use cases enforce domain invariants and interact with repositories via abstracted domain interfaces.

---

## 2. Threat Analysis (STRIDE)

| Threat Category            | Threat Description                                                                          | Affected Surface                                                                               | Inherent Risk | Mitigations Implemented                                                                                                                                                                                                         | Verification / Test Reference                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **S**poofing               | Forged Identity or API Key; impersonation of another tenant or administrative principal     | Authentication routes (`/auth/*`), Session management, Protected API routes                    | **Critical**  | Bearer JWT / API Key verification in `preHandler` hooks; cryptographic signature verification with constant-time comparison; `x-user-id` and `x-tenant-id` populated solely from authenticated tokens, never raw client headers | `packages/authorization/interface/hooks/resolve-principal.spec.ts`, `apps/api/tests/contract/openapi-contract.test.ts`                   |
| **T**ampering              | Parameter tampering, Mass Assignment, Request Body payload manipulation                     | User update routes, Role assignment (`/admin/users/:userId/roles`), Verification submissions   | **High**      | Strict JSON Schema / Zod validation with `additionalProperties: false` preventing unknown fields; Domain entities guard state transitions and ignore unintended parameters                                                      | `packages/authorization/interface/admin-roles.routes.ts`, `apps/api/src/routes/auth.ts`                                                  |
| **R**epudiation            | Deniability of administrative actions, role escalations, or security operations             | Audit logging, Admin endpoints (`/admin/*`), Session revocation                                | **Medium**    | Ubiquitous correlation IDs (`x-correlation-id` / `x-request-id`) injected on all incoming requests; structured JSON logging recording principal ID, action, target resource, and IP address                                     | `apps/api/src/plugins/request-id.ts`, `packages/authorization/interface/admin-roles.routes.ts`                                           |
| **I**nformation Disclosure | Broken Object-Level Authorization (BOLA/IDOR), User Enumeration, Leaked Stack Traces        | Error handling, User role query (`/admin/users/:userId/roles`), Password login (`/auth/login`) | **Critical**  | Organization-scoped query validation preventing cross-tenant role/user reads; constant-time dummy password hashing for non-existent users; normalized RFC 7807 error responses omitting stack traces                            | `packages/authorization/interface/bola-regression.spec.ts`, `docs/security/authentication-flows.md`                                      |
| **D**enial of Service      | Excessive payload size, Unbounded pagination, Hash-DoS, Replay attacks                      | Ingestion endpoints, List endpoints (`GET /admin/roles`, `GET /admin/users`), Login hashing    | **High**      | Fastify payload body limits (max 1MB); enforced pagination caps (maximum page size 100 with cursor pagination); Argon2 rate-limiting and account lockouts                                                                       | `apps/api/src/app.ts`, `packages/authorization/interface/admin-roles.routes.ts`                                                          |
| **E**levation of Privilege | Broken Function-Level Authorization (BFLA), Missing permission guards, Privilege escalation | Admin role assignment, System role mutation (`/admin/roles/:roleId`)                           | **Critical**  | Granular permission guards (`requirePermission("roles:write")`, `requirePermission("roles:read")`); immutability of system roles (`isSystemRole` protected against modification or deletion)                                    | `packages/authorization/interface/guards/require-permission.spec.ts`, `packages/authorization/application/use-cases/create-role.spec.ts` |

---

## 3. Detailed Threat Vectors & Architectural Mitigations

### 3.1 Broken Object-Level Authorization (BOLA / IDOR)

- **Risk**: An attacker possessing valid credentials for Organization A queries or modifies roles assigned to a user in Organization B by manipulating the `userId` or `organizationId` path/query parameters.
- **Mitigation**:
  - The API router requires explicit tenant and organization scoping. When retrieving or assigning roles (`GET /admin/users/:userId/roles`, `POST /admin/users/:userId/roles`), the request must provide the authorized `organizationId`.
  - The repository layer filters queries strictly by both `userId` and `organizationId`. A user belonging to another organization yields an empty result set or a 404/403, preventing cross-organization reconnaissance.
- **Regression Coverage**:
  - Validated by automated regression tests in `packages/authorization/interface/bola-regression.spec.ts`.

### 3.2 Mass Assignment & Parameter Injection

- **Risk**: An attacker submits unexpected JSON keys (e.g. `{ "isAdmin": true }` or `{ "isSystemRole": true }`) in POST/PATCH bodies to elevate privileges or corrupt data structures.
- **Mitigation**:
  - Route validation schemas explicitly declare `additionalProperties: false`. Payloads with extraneous fields are rejected at the HTTP boundary before reaching any domain use case.
  - Domain factory functions and use cases explicitly destructure permitted properties, ignoring raw unvalidated objects.

### 3.3 User & Tenant Enumeration

- **Risk**: An attacker determines whether an email or username exists in the system by comparing response codes, error details, or timing differences between valid and invalid identifiers.
- **Mitigation**:
  - All credential authentication failures return identical HTTP 401 `AUTHENTICATION_FAILED` errors.
  - To counter timing-based enumeration, the authentication handler runs a decoy Argon2 hash verification whenever a targeted user is not found, ensuring indistinguishable execution times (see `docs/security/authentication-flows.md`).

### 3.4 Token & Credential Exposure

- **Risk**: Sensitive bearer tokens, API keys, or verification secrets leak into application logs, HTTP headers, or client error responses.
- **Mitigation**:
  - Logging formatters redact sensitive headers (`Authorization`, `Cookie`, `x-api-key`) and payload fields (`password`, `token`, `secret`).
  - RFC 7807 problem details responses return clean, standardized machine-readable error codes and safe developer messages without leaking internal secrets or database connection metadata.

### 3.5 Replay Attacks & Request Integrity

- **Risk**: Stolen credentials or session requests are captured and replayed across tenants or time windows.
- **Mitigation**:
  - Time-limited JWTs and session tokens with explicit expiration timestamps (`exp`) and not-before claims (`nbf`).
  - Revocation lists and versioned session counters checked during authentication hook execution.

---

## 4. Verification and Security Testing

Security controls within Verixa are verified continuously across multiple testing tiers:

1. **Unit & Domain Policy Tests**: Verify combining algorithms, attribute matching, and role/permission assignment invariants (`packages/authorization/domain/*`).
2. **Route Guard & Hook Tests**: Verify unauthorized callers without proper permissions (`roles:read`, `roles:write`) receive HTTP 403 Forbidden (`packages/authorization/interface/guards/require-permission.spec.ts`).
3. **BOLA Regression Suite**: Validates isolation between organizations on role inspection and assignment endpoints (`packages/authorization/interface/bola-regression.spec.ts`).
4. **OpenAPI Contract Validation**: Ensures response status codes and schemas strictly match documented security definitions without leaking undeclared fields (`apps/api/tests/contract/openapi-contract.test.ts`).

---

## 5. References and Related Documentation

- `docs/security/authentication-flows.md` — In-depth analysis of authentication flows, user enumeration defenses, and decoy password hashing.
- `docs/guides/domain-modeling.md` — Domain isolation principles and clean architecture layering.
- `apps/api/src/plugins/security-headers.ts` — HTTP security header configuration (CSP, HSTS, X-Frame-Options, X-Content-Type-Options).
- OWASP API Security Top 10 (2023) — Alignment with API1:2023 (BOLA), API2:2023 (Broken Authentication), API3:2023 (BOPLA), and API5:2023 (BFLA).
