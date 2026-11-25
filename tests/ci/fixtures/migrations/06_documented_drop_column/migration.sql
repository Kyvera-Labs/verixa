-- Contract phase: Dropping column after deprecation window
-- DATA PRESERVATION: Column "deprecated_bio" was archived into cold storage table "archive_user_bios" on 2026-10-01.
ALTER TABLE "users" DROP COLUMN "deprecated_bio";
