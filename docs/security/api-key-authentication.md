# API-Key Authentication for Machine Clients

## Overview

Verixa supports API keys as first-class credentials for machine-to-machine integrations, CI/CD runners, automated background jobs, and internal services that must interact with the REST API without impersonating a human interactive session.

## Architecture & Security Principles

### 1. Hashed-at-Rest Storage
Plaintext API keys are **never stored** in the database.
- When an API key is created via `ApiKey.create()`, a high-entropy secret with prefix `vx_` is generated from a cryptographically secure random number generator (CSPRNG).
- The raw secret is returned to the caller **exactly once** in the creation response and never logged or stored.
- The database stores only the SHA-256 digest (`keyHash`), along with non-sensitive metadata such as a 4-character suffix (`keyPreview`) for user identification and debugging.
- In the event of a database compromise or backup leak, attackers cannot derive valid usable API keys from stored digests.

### 2. Constant-Time Verification
API key authentication computes the SHA-256 hash of the presented key and compares it against the stored digest using constant-time comparison (`crypto.timingSafeEqual`). This prevents side-channel timing attacks that could otherwise reconstruct key digests byte-by-byte.

### 3. Service Principals as First-Class Identities
API keys resolve to a `ServicePrincipal` rather than a human user:
- Distinct `type: "service_principal"` discriminant.
- Scoped to a specific `organizationId`.
- Carries an explicit list of granted `scopes` / permissions.
- Authorization layers branch directly on principal type to prevent privilege escalation or confusing service actions with human actions in audit logs.

### 4. Lifecycle & Revocation
- **Active**: Valid for authentication.
- **Revoked**: Explicitly deactivated prior to expiration.
- **Expired**: Past its configured `expiresAt` timestamp.
Revoked and expired keys are immediately rejected with `401 Unauthorized`.

### 5. Audit Logging
Every API key creation is recorded in the immutable audit log under the `api_key.created` action with metadata (`organizationId`, `name`, `keyPreview`), allowing security teams to track credential creation.

## Transport & Header Conventions

Clients authenticate by supplying the API key in either of the following HTTP headers:

```http
Authorization: ApiKey vx_YOUR_SECRET_API_KEY
```

Or:

```http
X-API-Key: vx_YOUR_SECRET_API_KEY
```
