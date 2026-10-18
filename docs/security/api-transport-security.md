# API Transport Security and CORS Policy

This document details the transport-level security policy and Cross-Origin Resource Sharing (CORS) rules for the Verixa REST API (Issue 235 / roadmap Phase 12).

## Threat Model and Principles

The API serves sensitive authentication, identity, and authorization data. Browsers querying these endpoints are subject to cross-origin security constraints. Without explicit CORS handling and tight transport controls:

1. Malicious third-party origins could execute credentialed requests against the API on behalf of authenticated users (CSRF / cross-origin data exposure).
2. APIs might leak authentication cookies or Authorization headers to unauthorized origins.
3. Lack of strict HTTP response headers leaves user agents vulnerable to MIME-type sniffing, clickjacking, and unencrypted transport down-grades.

### The Invariant: Defense in Depth at the Root Boundary

CORS and security headers are enforced globally at the root Fastify instance (`apps/api/src/app.ts` / `apps/api/src/plugins/cors.ts` / `apps/api/src/plugins/security-headers.ts`). Applying these at the root ensures that:

- Every endpoint—including 404s, health checks, and future dynamic routes—inherits consistent, audit-proof transport policies.
- Unauthenticated preflight (`OPTIONS`) requests are answered predictably according to an explicit allow-list.

---

## CORS Configuration

Cross-Origin Resource Sharing is implemented via `@fastify/cors` with an explicit origin validator function:

### Allowed Origins

Origins are strictly matched against a validated allow-list:

- **Production Defaults (`NODE_ENV === "production"`)**:
  - `https://app.verixa.io`
  - `https://api.verixa.io`
- **Development / Test Defaults**:
  - `http://localhost:3000`
  - `http://localhost:5173`
  - `http://127.0.0.1:3000`
  - `http://127.0.0.1:5173`

Requests missing an `Origin` header (such as server-to-server calls, mobile clients, and cURL requests) are permitted, as they do not operate within browser cross-origin sandboxes. Any browser-origin not in the explicit allow-list is rejected.

### Credentials and Headers

- **`credentials: true`**: Allows browsers to pass cookies and Authorization headers on cross-origin requests from explicitly approved origins. Wildcard `*` origins are strictly forbidden when credentials are enabled.
- **Allowed Headers**:
  - `Origin`
  - `X-Requested-With`
  - `Content-Type`
  - `Accept`
  - `Authorization`
  - `X-Request-Id`
  - `X-Api-Key`
  - `Idempotency-Key`
- **Exposed Headers**:
  Headers that clients are permitted to read from API responses:
  - `X-Request-Id`
  - `X-RateLimit-Limit`
  - `X-RateLimit-Remaining`
  - `X-RateLimit-Reset`
  - `Retry-After`

---

## Security Headers Baseline

Security headers complement CORS to harden responses against client-side exploitation:

| Header                      | Value                                                                             | Purpose                                                                        |
| --------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `Content-Security-Policy`   | `default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` | Restricts browser evaluation; API responses are JSON and never HTML documents. |
| `X-Content-Type-Options`    | `nosniff`                                                                         | Prevents browsers from MIME-sniffing response types.                           |
| `X-Frame-Options`           | `DENY`                                                                            | Prevents framing and clickjacking attacks.                                     |
| `Referrer-Policy`           | `no-referrer`                                                                     | Ensures tokens and ids in URLs are never leaked in referrer headers.           |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains`                                             | Mandates TLS connection over HTTPS for modern browsers.                        |
| `X-Powered-By`              | _removed_                                                                         | Suppresses technology fingerprinting.                                          |

### Development vs Production

- In local development (`NODE_ENV !== "production"`), HSTS enforcement is disabled by default (`NO_TRANSPORT_SECURITY`) to allow unencrypted local loopback testing over `http://localhost` without SSL certificate errors.
- In production, HSTS is mandated with a minimum `max-age` of 1 year (`31536000` seconds).
