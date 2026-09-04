-- Row-Level Security for tenant-scoped tables (Issue 052, ADR-0002).
--
-- Application code already filters by organization. This is the layer
-- underneath that: a missing or wrong WHERE clause in a repository still
-- cannot return another tenant's rows, because Postgres removes them before
-- the query sees them. Application-level filtering fails *open* on a mistake
-- (you get too much data, silently); RLS fails *closed*.
--
-- `users` is deliberately NOT covered. A user is a global identity that can
-- belong to several organizations at once (ADR-0002 chose row-level isolation
-- partly to support exactly that), so there is no single organization_id to
-- scope a user row by. Tenant scoping for users is expressed through
-- organization_memberships, which is covered.

-- The tenant is carried in a per-transaction setting rather than a WHERE
-- clause. Policies read it with missing_ok = true, so an unset value yields
-- NULL and every comparison below is NULL — excluding all rows. Forgetting to
-- set the context therefore returns nothing rather than everything.
--
-- NULLIF(..., '') matters: an unset setting reads as NULL, but a setting
-- explicitly assigned an empty string reads as '', and ''::uuid raises an
-- error instead of filtering. Normalizing '' to NULL keeps both paths closed
-- rather than crashing.

ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;

-- ENABLE alone exempts the table owner, and the owner is exactly who the
-- application connects as in most setups — so without FORCE these policies
-- would be silently inert for the only role that matters. This is the
-- "RLS fails open when misconfigured" hazard ADR-0002 flagged.
--
-- FORCE still does not constrain a Postgres SUPERUSER, which bypasses RLS
-- unconditionally and cannot be made subject to it. The application must
-- therefore connect as a non-superuser role. See docs/security/multi-tenancy.md.
ALTER TABLE "organizations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "organization_memberships" FORCE ROW LEVEL SECURITY;
ALTER TABLE "invitations" FORCE ROW LEVEL SECURITY;

-- For `organizations` the tenant key is the row's own id: an organization is
-- the tenant, so a tenant may see exactly itself.
CREATE POLICY "tenant_isolation" ON "organizations"
    USING ("id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
    WITH CHECK ("id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

CREATE POLICY "tenant_isolation" ON "organization_memberships"
    USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
    WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

CREATE POLICY "tenant_isolation" ON "invitations"
    USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
    WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

-- USING governs which rows are visible to SELECT/UPDATE/DELETE; WITH CHECK
-- governs which rows may be written by INSERT/UPDATE. Both are specified
-- deliberately: USING alone would let a tenant *insert* a row belonging to
-- another organization — writing data it could then never see. Cross-tenant
-- writes are as much a breach as cross-tenant reads.
