ALTER TABLE "organizations"
  ADD COLUMN "parent_organization_id" UUID;

ALTER TABLE "organizations"
  ADD CONSTRAINT "organizations_parent_organization_id_fkey"
  FOREIGN KEY ("parent_organization_id") REFERENCES "organizations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "organizations_parent_organization_id_idx"
  ON "organizations"("parent_organization_id");
