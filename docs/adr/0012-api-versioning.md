# ADR-0012: API Versioning Strategy

## Status

Accepted

## Context

Phase 12 of the Verixa roadmap establishes `apps/api`'s REST surface, exposing bounded contexts (such as auth, authorization, verification, and audit) over HTTP to web and machine clients.

As APIs evolve, schema contracts, parameter semantics, and response envelopes will inevitably require non-backward-compatible modifications. Without a clear versioning strategy, evolving the API poses a severe risk of silently breaking automated machine clients and integrations. Furthermore, retiring old routes requires a documented deprecation policy so consumers have adequate transition notice.

## Decision

1. **URI-path Versioning (`/v1/...`) as Primary Strategy**:
   - All public REST API routes live under a major version prefix (e.g., `/v1/auth`, `/v1/audit`).
   - The version identifier in the URI path represents breaking contract changes at the API surface. Non-breaking additions (e.g., optional fields in responses) do not bump the version.
   - Unversioned endpoints are strictly reserved for operational infrastructure routes (`/health`, `/docs`, `/docs/openapi.json`, `/favicon.ico`).
   - Any request to an unversioned route or an unsupported version prefix is rejected immediately by the version-negotiation plugin rather than silently defaulting to a fallback version.

2. **Deprecation & Sunset HTTP Headers**:
   - Routes marked for retirement are decorated with `deprecated: true` and a `sunset` date or timestamp.
   - When requested, deprecated routes emit:
     - `Deprecation: true` (RFC draft-ietf-httpapi-deprecation-header)
     - `Sunset: <http-date>` (RFC 8594) indicating the planned shutdown date.
   - Minimum deprecation notice period is 6 months before complete route removal.

## Consequences

- **Explicit Contracts**: Clients must explicitly specify `/v1/` in all API requests. A client cannot inadvertently receive changes intended for another major version.
- **Fail-Fast Negotiation**: Malformed or unversioned client requests fail fast with standard 400 `VALIDATION_ERROR` or 404 `NOT_FOUND` error envelopes, pointing developers directly to versioned routes.
- **Cache & Proxy Transparency**: URIs remain completely transparent and cacheable by CDNs and edge reverse proxies without requiring custom `Vary: Accept` configurations.

## Alternatives Considered

- **Header / Content-Negotiation Versioning (`Accept: application/vnd.verixa.v1+json`)**:
  - _Tradeoff_: Header versioning is often cited as "RESTfully pure" because the URI identifies the resource while headers specify the representation.
  - _Why rejected_: Headers are invisible in browser address bars, cumbersome to test via simple curl/tools, and easily stripped or mishandled by intermediate proxies, CDNs, and client libraries. URI-path versioning makes the version boundary obvious, debuggable, and bookmarkable.
- **Query Parameter Versioning (`?v=1`)**:
  - _Why rejected_: Query parameters can easily be omitted, conflict with pagination/filtering parameters, and encourage sloppy client configurations.
