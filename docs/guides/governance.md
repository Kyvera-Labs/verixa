# Governance HTTP surface

The organization administration API lives under `/admin/organizations` and is
intentionally a thin transport adapter. It validates request shape at the
Fastify boundary, checks a platform-level permission, and delegates creation,
reading, and updates to the identity use cases. That keeps authorization and
organization invariants in the same application/domain layers used by other
callers.

The first version uses the existing identity organization aggregate rather than
introducing a second `governance` aggregate. The alternative was to create a
new package before the organization lifecycle and membership use cases from
the Phase 16 dependencies exist on `main`; that would duplicate persistence
ports and make the API contract depend on code that is not yet available.
When those governance use cases land, this route adapter can change its
container interface without changing the HTTP contract.

Platform administration is checked with `organizations:read` for reads and
`organizations:write` for mutations, using a `null` organization scope. A
request without the platform permission receives `403`; no organization
lookup is performed first, which avoids turning the endpoint into an
enumeration aid.

`PATCH` only changes `name` and `slug`. The owner and lifecycle status are not
implicitly changed by a generic update; those transitions need their own
explicit use cases and audit semantics.
