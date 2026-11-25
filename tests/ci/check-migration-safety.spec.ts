import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  checkMigrationSql,
  checkMigrationsDirectory,
  runMigrationSafetyCheck,
} from "../../infra/ci/check-migration-safety.js";

const REPO_ROOT = resolve(__dirname, "../..");
const FIXTURES_DIR = resolve(__dirname, "fixtures/migrations");
const PROD_MIGRATIONS_DIR = resolve(REPO_ROOT, "packages/database/prisma/migrations");
const FIX_FORWARD_TEMPLATE = resolve(
  REPO_ROOT,
  "packages/database/prisma/templates/fix-forward.sql",
);

describe("Migration Safety & Policy Checkers (Issues 393 & 394 / #505 & #506)", () => {
  describe("Forward-Only Migration Policy (Issue 393 / #505)", () => {
    it("flags an undocumented DROP COLUMN as a blocking error", () => {
      const sql = readFileSync(
        resolve(FIXTURES_DIR, "04_undocumented_drop_column/migration.sql"),
        "utf-8",
      );
      const result = checkMigrationSql(sql);

      expect(result.passed).toBe(false);
      expect(result.errors).toHaveLength(1);
      const firstError = result.errors[0]!;
      expect(firstError.rule).toBe("forward-only-destructive-change");
      expect(firstError.message).toContain("DROP COLUMN");
      expect(firstError.message).toContain("DATA PRESERVATION");
    });

    it("flags an undocumented DROP TABLE as a blocking error", () => {
      const sql = readFileSync(
        resolve(FIXTURES_DIR, "05_undocumented_drop_table/migration.sql"),
        "utf-8",
      );
      const result = checkMigrationSql(sql);

      expect(result.passed).toBe(false);
      expect(result.errors).toHaveLength(1);
      const firstError = result.errors[0]!;
      expect(firstError.rule).toBe("forward-only-destructive-change");
      expect(firstError.message).toContain("DROP TABLE");
    });

    it("allows DROP COLUMN when a DATA PRESERVATION note is documented", () => {
      const sql = readFileSync(
        resolve(FIXTURES_DIR, "06_documented_drop_column/migration.sql"),
        "utf-8",
      );
      const result = checkMigrationSql(sql);

      expect(result.passed).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("allows DROP TABLE when a DATA PRESERVATION note is documented", () => {
      const sql = readFileSync(
        resolve(FIXTURES_DIR, "07_documented_drop_table/migration.sql"),
        "utf-8",
      );
      const result = checkMigrationSql(sql);

      expect(result.passed).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("fix-forward migration template exists and contains required guidance", () => {
      expect(existsSync(FIX_FORWARD_TEMPLATE)).toBe(true);
      const content = readFileSync(FIX_FORWARD_TEMPLATE, "utf-8");
      expect(content).toContain("Forward-Only Migration Policy");
      expect(content).toContain("DATA PRESERVATION");
      expect(content).toContain("INCIDENT TICKET");
      expect(content).toContain("Compensating Schema Adjustments");
    });
  });

  describe("Zero-Downtime Migration Compatibility Checklist (Issue 394 / #506)", () => {
    it("flags adding NOT NULL column without DEFAULT as an advisory warning", () => {
      const sql = readFileSync(
        resolve(FIXTURES_DIR, "03_incompatible_not_null_no_default/migration.sql"),
        "utf-8",
      );
      const result = checkMigrationSql(sql);

      expect(result.warnings).toHaveLength(1);
      const firstWarning = result.warnings[0]!;
      expect(firstWarning.rule).toBe("zero-downtime-not-null-no-default");
      expect(firstWarning.message).toContain("NOT NULL");
      expect(firstWarning.message).toContain("without a DEFAULT");
      expect(firstWarning.guidance).toContain("expand/contract");
    });

    it("permits adding a nullable column during the expand phase", () => {
      const sql = readFileSync(
        resolve(FIXTURES_DIR, "01_compatible_add_nullable/migration.sql"),
        "utf-8",
      );
      const result = checkMigrationSql(sql);

      expect(result.passed).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it("permits adding a NOT NULL column when a DEFAULT value is provided", () => {
      const sql = readFileSync(
        resolve(FIXTURES_DIR, "02_compatible_add_with_default/migration.sql"),
        "utf-8",
      );
      const result = checkMigrationSql(sql);

      expect(result.passed).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it("ignores CREATE TABLE statements with NOT NULL columns because new tables do not break existing replicas", () => {
      const sql = `
CREATE TABLE "new_feature_flags" (
    "id" UUID NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL
);
`;
      const result = checkMigrationSql(sql);
      expect(result.passed).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });
  });

  describe("Directory scanning and production migrations verification", () => {
    it("scans fixture migrations directory and aggregates all issues correctly", () => {
      const results = checkMigrationsDirectory(FIXTURES_DIR);
      expect(results.length).toBeGreaterThanOrEqual(7);

      const allErrors = results.flatMap((r) => r.errors);
      const allWarnings = results.flatMap((r) => r.warnings);

      expect(allErrors.length).toBe(2); // 04 and 05
      expect(allWarnings.length).toBe(1); // 03
    });

    it("all committed production migrations in packages/database/prisma/migrations pass safety checks", () => {
      const summary = runMigrationSafetyCheck({
        migrationsDir: PROD_MIGRATIONS_DIR,
        strict: true,
      });

      expect(summary.totalChecked).toBeGreaterThan(0);
      expect(summary.totalErrors).toBe(0);
      expect(summary.totalWarnings).toBe(0);
      expect(summary.passed).toBe(true);
    });
  });
});
