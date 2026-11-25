-- Compatible addition: NOT NULL with DEFAULT constraint
ALTER TABLE "organizations" ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true;
