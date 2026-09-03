-- CreateEnum
CREATE TYPE "organization_status" AS ENUM ('active', 'suspended', 'deleted');

-- CreateEnum
CREATE TYPE "membership_status" AS ENUM ('active', 'revoked');

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" CITEXT NOT NULL,
    "owner_id" UUID NOT NULL,
    "status" "organization_status" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_memberships" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "status" "membership_status" NOT NULL,
    "joined_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organization_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE INDEX "organization_memberships_organization_id_idx" ON "organization_memberships"("organization_id");

-- CreateIndex
CREATE INDEX "organization_memberships_user_id_organization_id_idx" ON "organization_memberships"("user_id", "organization_id");

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A user may hold at most one *active* membership per organization, but any
-- number of revoked ones (leaving and rejoining is normal). A plain composite
-- UNIQUE would forbid the second join; this partial index constrains only the
-- rows the rule is actually about.
--
-- Hand-written because Prisma's schema language cannot express a partial
-- index (no WHERE clause on @@unique), so this object is unmanaged by Prisma
-- and lives only here. See docs/guides/database.md.
--
-- This mirrors the check already performed in OrganizationMembership.create()
-- — deliberately, not redundantly. The domain check gives a typed, friendly
-- ConflictError on the normal path; this one holds under concurrency, where
-- two simultaneous requests can both read "no active membership" before
-- either writes.
CREATE UNIQUE INDEX "organization_memberships_active_unique"
    ON "organization_memberships" ("user_id", "organization_id")
    WHERE "status" = 'active';
