/**
 * The Postgres setting that carries the current tenant for Row-Level
 * Security (Issue 052, ADR-0002).
 *
 * Deliberately dependency-free: this module defines the *contract* between
 * the RLS policies in the migration and whatever runs queries. The Prisma
 * wiring lives with the adapters (`packages/identity/infrastructure/
 * persistence/prisma-tenant-context.ts`), so the shared kernel stays free of
 * any ORM.
 */

/** Must match the setting name used by the policies in the RLS migration. */
export const TENANT_CONTEXT_SETTING = "app.current_organization_id";

/**
 * Why the value is set with `set_config(..., is_local => true)` rather than
 * `SET` — the single most important detail in this whole mechanism.
 *
 * **Transaction-scoped, not session-scoped.** Plain `SET` persists for the
 * life of the *connection*. Connections are pooled and handed to unrelated
 * requests, so a session-scoped tenant would leak into whichever request got
 * that connection next: tenant A's context silently applied to tenant B's
 * queries. That is the worst failure this system could have, it would be
 * intermittent and load-dependent, and it would look like data corruption
 * rather than a security bug. `is_local => true` scopes the value to the
 * surrounding transaction, so it is discarded at commit or rollback and can
 * never outlive the work it belongs to.
 *
 * This is why every tenant-scoped operation must run inside a transaction.
 * Outside one, `is_local => true` applies to the implicit single-statement
 * transaction and is gone immediately — the setting would be unset by the
 * time the next statement runs, and RLS would return zero rows. That failure
 * is at least loud and closed rather than silent and open.
 *
 * **Parameterized, not interpolated.** `SET LOCAL x = $1` is not valid SQL —
 * `SET` does not accept bind parameters, so using it would force string
 * interpolation of a value into a statement, which is a SQL-injection sink in
 * the one place where a mistake defeats tenant isolation entirely.
 * `set_config()` is an ordinary function call and takes parameters normally,
 * so the value is bound rather than concatenated. Equivalent behavior, no
 * injection surface.
 */
export const TENANT_CONTEXT_MECHANISM = "set_config(is_local => true)" as const;

/**
 * Guards against a category of mistake the type system cannot: an empty
 * string reads back from `current_setting` as `''` rather than NULL, and the
 * policies cast it with `NULLIF(..., '')::uuid` precisely so that case
 * filters rather than raising. Rejecting it here too means the error surfaces
 * at the call site, with a useful message, instead of as an empty result set
 * somewhere downstream.
 */
export function assertValidTenantId(organizationId: string): void {
  if (organizationId.trim() === "") {
    throw new Error(
      "Tenant context requires a non-empty organization id. An empty value would " +
        "leave RLS with no tenant and silently match zero rows.",
    );
  }
}
