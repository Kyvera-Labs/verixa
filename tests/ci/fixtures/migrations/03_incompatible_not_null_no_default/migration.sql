-- Incompatible addition: NOT NULL without default in a single step
ALTER TABLE "users" ADD COLUMN "tax_id" TEXT NOT NULL;
