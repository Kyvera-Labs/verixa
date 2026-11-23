-- =============================================================================
-- Verixa Forward-Only Migration Policy: Fix-Forward Migration Template
-- Reference: Issue 393 (#505) / Issue 394 (#506) / docs/guides/deployment.md
-- =============================================================================
--
-- POLICY OVERVIEW:
-- Production databases operate on a strictly forward-only migration policy.
-- Destructive down-migrations are prohibited in production because:
-- 1. Down-migrations are rarely tested, prone to silent data truncation, and irreversible.
-- 2. Rolling deployment replicas depend on schema compatibility; reverting schema breaks live pods.
--
-- HOW TO USE THIS TEMPLATE:
-- When a previously deployed migration contains a flaw (e.g. missing constraint, wrong type,
-- incomplete backfill, or unintended side-effect):
-- 1. Create a NEW forward migration via:
--      pnpm --filter @verixa/database exec prisma migrate dev --create-only --name fix_forward_<description>
-- 2. Adapt the steps below into the newly created `migration.sql`.
-- 3. If any data is relocated or dropped, ensure the DATA PRESERVATION comment block is filled.
-- 4. Test the fix against a copy of staging before deploying.
-- =============================================================================

-- Step 1: Document the incident, original migration, and root cause
-- INCIDENT TICKET: #<issue-or-incident-number>
-- TARGET MIGRATION: <YYYYMMDDHHMMSS_original_migration_name>
-- ROOT CAUSE: <Explanation of the flaw, e.g. Column constraint was too tight for existing legacy data>

-- Step 2: Data Preservation & Recovery Note (Mandatory if dropping or modifying data)
-- DATA PRESERVATION:
-- 1. Archive Strategy: <e.g., Data archived to table "legacy_backup_<date>" prior to alteration>
-- 2. Impacted Records: <e.g., Zero rows affected, verified by query SELECT count(*) FROM ...>
-- 3. Verification Command: <e.g., SELECT id FROM users WHERE status IS NULL; must return 0>

-- Step 3: Compensating Schema Adjustments
-- Example A: Safely relaxing an overly restrictive constraint without downtime
-- ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_display_name_check";
-- ALTER TABLE "users" ADD CONSTRAINT "users_display_name_check" CHECK (char_length("display_name") >= 1);

-- Example B: Correcting a column without breaking running replicas (Expand-Contract)
-- 1. Add new corrected column as nullable
-- ALTER TABLE "organizations" ADD COLUMN "slug_v2" CITEXT;
-- 2. Backfill existing rows
-- UPDATE "organizations" SET "slug_v2" = LOWER("slug") WHERE "slug_v2" IS NULL;
-- 3. Enforce constraint in subsequent release once application writes to slug_v2

-- Step 4: Validate schema integrity
-- Any post-migration validation query or comment verifying fix completion.
