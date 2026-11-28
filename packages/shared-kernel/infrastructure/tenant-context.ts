/**
 * The Postgres setting that carries the current tenant for Row-Level Security (ADR-0002).
 * Dependency-free: the contract between the RLS policies and query code. The Prisma wiring is in
 * `packages/identity/infrastructure/persistence/prisma-tenant-context.ts`.
 */

/** Must match the setting name used by the policies in the RLS migration. */
export const TENANT_CONTEXT_SETTING = "app.current_organization_id";

/**
 * The tenant is set with `set_config(..., is_local => true)`, not `SET`.
 *
 * Transaction-scoped: plain `SET` lasts for the pooled connection's lifetime and would leak one
 * tenant's context into another request. `is_local => true` discards it at commit or rollback.
 * Tenant-scoped work must therefore run in a transaction; outside one the setting vanishes
 * immediately and RLS returns no rows, which fails closed.
 *
 * Parameterized: `SET` cannot take bind parameters, so it would force string interpolation.
 * `set_config()` is a normal function call with bound parameters.
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
