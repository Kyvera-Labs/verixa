# Multi-Tenancy and Row-Level Security

Verixa isolates tenants by row, not by schema or database
([ADR-0002](../adr/0002-multi-tenancy-model.md)). Every tenant-scoped table
carries an `organization_id`, and Postgres **Row-Level Security** enforces
that a connection only sees rows for the organization it is currently acting
as.

## ⚠️ Deployment requirement: do not connect as a superuser

**A Postgres superuser bypasses RLS unconditionally.** There is no
configuration that makes a superuser subject to a policy — not `ENABLE`, not
`FORCE`. If the application connects as one, every policy in this document is
silently inert, no error is raised, and nothing in the application behaves
differently. You would find out from a support ticket.

The application role must be an ordinary `LOGIN` role with table privileges
and nothing more:

```sql
CREATE ROLE verixa_app LOGIN PASSWORD '...';
GRANT USAGE ON SCHEMA public TO verixa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO verixa_app;
```

Migrations still run as the owner, which needs the elevated rights that RLS
deliberately withholds from the app.

**Current state, stated plainly:** local development, CI, and the test
containers all connect as `verixa`, which the official Postgres image creates
as a superuser. RLS is therefore **not currently active for the application**
in any of those environments. The policies exist and are verified (see
below), but they protect a production deployment that uses a restricted role
— they are not protecting anything today. Closing that gap is deployment
work, tracked for Phase 20.

## What is and isn't covered

| Table                      | RLS                            | Why                              |
| -------------------------- | ------------------------------ | -------------------------------- |
| `organizations`            | ✅ scoped by `id`              | The organization _is_ the tenant |
| `organization_memberships` | ✅ scoped by `organization_id` |                                  |
| `invitations`              | ✅ scoped by `organization_id` |                                  |
| `users`                    | ❌ not scoped                  | A user is a **global identity**  |

`users` is excluded deliberately. A person can belong to several
organizations at once — a consultant working with multiple clients — which is
one of the reasons ADR-0002 chose row-level isolation in the first place.
There is no single `organization_id` to scope a user row by, and inventing
one would make multi-org membership unrepresentable. Tenant scoping for
people is expressed through `organization_memberships`, which _is_ covered.

## How the tenant context works

Policies read a per-transaction setting rather than trusting a `WHERE`
clause:

```sql
CREATE POLICY "tenant_isolation" ON "organization_memberships"
    USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
    WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
```

Application code sets it through `withTenantContext`:

```ts
const memberships = await withTenantContext(
  prisma,
  organizationId,
  (tx) => tx.organizationMembership.findMany(), // no WHERE — and none trusted
);
```

Four details in there are load-bearing.

**It fails closed.** `current_setting(..., true)` returns NULL when unset, so
every comparison is NULL and _no_ rows match. Forgetting to establish tenant
context returns nothing. Compare that to application-level filtering, where
forgetting the `WHERE` returns **everything** — the same mistake, opposite
blast radius.

**`NULLIF(..., '')` is not decoration.** An unset setting reads as NULL, but
one explicitly assigned an empty string reads as `''`, and `''::uuid` raises
an error rather than filtering. Normalizing empty to NULL keeps both paths
closed instead of crashing.

**`WITH CHECK`, not just `USING`.** `USING` governs which rows are _visible_;
`WITH CHECK` governs which rows may be _written_. With only `USING`, a tenant
could insert a row belonging to another organization — writing data it could
then never see. A cross-tenant write is as much a breach as a cross-tenant
read.

**The setting is transaction-scoped.** See below; this is the part most
likely to be got wrong.

## Connection pooling: the caveat that matters most

Tenant context is set with `set_config(name, value, is_local => true)` —
transaction-scoped — never with session-scoped `SET`.

With a connection pool, a session-scoped setting outlives the request that
set it. The connection returns to the pool still carrying tenant A's context,
gets handed to a request for tenant B, and tenant A's policies apply to
tenant B's queries. That bug is intermittent, load-dependent, invisible in
development, and presents as data corruption rather than as a security
failure. It is the single worst thing that could go wrong here.

`is_local => true` binds the value to the surrounding transaction, so it is
discarded on commit or rollback and cannot outlive the work it belongs to.

**The corollary: tenant-scoped work must happen inside a transaction.**
Outside one, the setting applies to the implicit single-statement transaction
and is gone before the next statement — RLS then matches zero rows. That
failure is at least loud and closed rather than silent and open.
`withTenantContext` enforces this by opening the transaction itself.

There is also a reason it is `set_config()` and not `SET LOCAL`: `SET` does
not accept bind parameters, so using it would require interpolating a value
into SQL text — an injection sink in the one place where a mistake defeats
tenant isolation entirely. `set_config()` is an ordinary function call and
binds its arguments normally.

If PgBouncer is introduced later, it must run in **session or transaction
pooling mode with transactions intact**. Statement-level pooling would break
this outright by splitting a transaction across connections.

## Verification

`tests/integration/row-level-security.spec.ts` proves the properties above
against a real database, connecting as a **purpose-created unprivileged
role** rather than the usual superuser — because as a superuser the
assertions would all pass while proving nothing.

It covers: no context returns zero rows; a set context returns only that
tenant's rows; a query explicitly naming another tenant still returns
nothing; `organizations` scopes to itself; a cross-tenant write is rejected
by `WITH CHECK`; context does not survive onto the next transaction on the
same pooled connection; and `users` remains visible across tenants.

## Defense in depth, not a replacement

RLS is the layer _underneath_ application-level scoping, not instead of it.
Repositories should still filter by organization: the application layer gives
correct, intentional queries and useful errors, while RLS is the backstop for
the query that was wrong anyway. Relying on RLS alone would mean every
missing filter silently returns an empty result set instead of an error —
correct, but very hard to debug.
