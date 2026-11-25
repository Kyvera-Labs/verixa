-- Dropping a legacy column without documenting an archive or preservation procedure
ALTER TABLE "users" DROP COLUMN "legacy_token";
