# ADR-0002: Multi-tenancy model — row-level `organizationId` with Postgres RLS

## Status

Accepted

## Context

`planning/ARCHITECTURE.md` §8 flagged multi-tenancy as an open question,
leaning toward row-level tenant isolation but not committing: "schema-per-
tenant vs. row-level `tenant_id` (leaning row-level with Postgres RLS for
simplicity + Postgres-native security)." Phase 03 (Database & Persistence)
needs a settled answer before it can design table schemas or repository
adapters — every table that stores organization-scoped data needs to know
now whether isolation happens at the schema level or the row level, because
retrofitting the other choice later means a data migration, not a config
change.

Phase 02's domain modeling surfaced enough to decide this concretely, not
just in the abstract:

- `Organization` (Issue 024) is a normal aggregate with a single `id`, not a
  schema or a connection-string parameter — nothing about how it was
  modeled assumes or requires per-tenant physical isolation.
- `OrganizationMembership` (Issue 025) links a `UserId` to an
  `OrganizationId` as ordinary foreign-key-shaped data, the same as any
  other relationship in the system — a `User` who belongs to multiple
  organizations (a real, expected case, e.g. a consultant working with
  several client orgs) is naturally representable as multiple membership
  rows referencing the same `userId`, which schema-per-tenant would
  actively complicate (which schema does a cross-org user's identity live
  in?).
- Every aggregate that will eventually be organization-scoped (audit
  events, verification requests, future RBAC role assignments) is expected
  to carry an explicit `organizationId` field already, by the same
  modeling convention used everywhere else in this codebase — branded IDs
  as plain foreign keys, not connection-level routing.

In short: nothing built so far assumed schema-per-tenant, and everything
built so far fits row-level isolation without friction. That's the signal
this decision was ready to make now rather than deferred further.

## Decision

**Row-level multi-tenancy**: every organization-scoped table carries an
`organization_id` column (referencing `Organization.id`), and Postgres
**Row-Level Security (RLS)** policies enforce that a given database session
can only see/modify rows for the organization(s) it's authorized for. All
tenants share the same schema and the same physical tables — isolation is
enforced by Postgres itself at query time, not by application code
remembering to add a `WHERE organization_id = ?` clause to every query, and
not by routing different tenants to different schemas or databases.

The mechanics (deferred to Phase 03, recorded here so that work has a
target): each Prisma-backed repository adapter sets the current
organization context for RLS to evaluate against (e.g. via
`SET LOCAL app.current_organization_id` at the start of a
transaction/request), and RLS policies on each table reference that setting.
Application code still passes `organizationId` explicitly where the domain
model already calls for it (e.g. `CreateOrganization`,
`OrganizationMembershipRepository`) — RLS is a second, database-enforced
layer underneath that, not a replacement for it.

## Consequences

- **One schema, one set of migrations, one connection pool** regardless of
  tenant count — operationally far simpler than schema-per-tenant, which
  would mean provisioning, migrating, and monitoring N schemas as the
  organization count grows.
- **Cross-org users are trivial to represent** (multiple
  `OrganizationMembership` rows), and cross-org admin/reporting queries
  (e.g. a platform-level audit view spanning all organizations) are
  ordinary SQL, not federated queries across N schemas.
- **Isolation is enforced by Postgres, not by every developer remembering
  a `WHERE` clause.** A bug that omits an organization filter in
  application code still can't leak another organization's rows, because
  RLS blocks it at the database level regardless of what the query above it
  did or didn't ask for. This is a meaningfully stronger default than
  "our repository layer is careful about it."
- **A noisy-neighbor / resource-isolation tradeoff**: an extremely large
  organization's data lives in the same physical tables as every other
  organization's, so there's no per-tenant storage or I/O isolation the way
  schema- or database-per-tenant would provide. Acceptable for Verixa's
  target scale (this is infrastructure meant to be self-hosted per
  deployment, not a single multi-million-tenant SaaS); revisit if that
  assumption changes.
- **RLS policies are an easy thing to get wrong silently** — a missing or
  misconfigured policy on a new table fails open (no isolation), not
  closed. Phase 03's adapter work needs an explicit checklist/test
  (a query as one organization must never see another's rows) rather than
  relying on RLS "just being there."

## Alternatives Considered

- **Schema-per-tenant** — rejected: operationally heavier (N schemas to
  migrate/monitor as tenants grow), and actively awkward for a user
  belonging to multiple organizations, which Phase 02's domain model
  already treats as a normal case, not an edge case.
- **Database-per-tenant** — rejected for the same reasons as schema-per-
  tenant, more severely: connection pooling, migrations, and cross-tenant
  reporting all get harder, for an isolation guarantee Verixa's target
  deployment model (self-hosted, not massive multi-tenant SaaS) doesn't
  need.
- **Row-level isolation enforced only in application code (repository-layer
  filtering), no RLS** — rejected as the _sole_ mechanism: it's simpler to
  implement immediately, but every repository method becomes a place a
  missing filter silently leaks data, with no independent enforcement layer
  underneath it. RLS is kept as a defense-in-depth backstop specifically
  because application-layer discipline alone has a worse failure mode
  (fails open on a mistake, no second line of defense).
