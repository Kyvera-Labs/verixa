#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * Severity level of a migration safety finding.
 */
export type IssueSeverity = "error" | "warning";

/**
 * Unique identifiers for safety check rules.
 */
export type RuleId = "forward-only-destructive-change" | "zero-downtime-not-null-no-default";

/**
 * A safety violation or advisory finding identified in a migration script.
 */
export interface MigrationSafetyIssue {
  readonly rule: RuleId;
  readonly severity: IssueSeverity;
  readonly message: string;
  readonly line: number;
  readonly statement: string;
  readonly guidance?: string;
}

/**
 * Result of checking a single migration file.
 */
export interface MigrationCheckResult {
  readonly filePath: string;
  readonly passed: boolean;
  readonly errors: readonly MigrationSafetyIssue[];
  readonly warnings: readonly MigrationSafetyIssue[];
}

/**
 * Summary of checking multiple migrations across a repository.
 */
export interface MigrationSafetySummary {
  readonly totalChecked: number;
  readonly passed: boolean;
  readonly results: readonly MigrationCheckResult[];
  readonly totalErrors: number;
  readonly totalWarnings: number;
}

/**
 * Comment marker required for destructive changes to document data preservation (Issue 393).
 */
const DATA_PRESERVATION_NOTE_PATTERN = /DATA[-_ ]?PRESERVATION\s*:|@data-preservation/i;

/**
 * Safely inspects whether a SQL statement represents a destructive drop operation.
 */
function inspectDestructiveOperation(statement: string): { isDestructive: boolean; op: string } {
  const upper = statement.toUpperCase();

  if (upper.includes("DROP TABLE")) {
    return { isDestructive: true, op: "DROP TABLE" };
  }

  if (upper.includes("ALTER TABLE") && upper.includes("DROP COLUMN")) {
    return { isDestructive: true, op: "DROP COLUMN" };
  }

  if (upper.includes("DROP SCHEMA")) {
    return { isDestructive: true, op: "DROP SCHEMA" };
  }

  if (
    upper.includes("TRUNCATE TABLE") ||
    upper.startsWith("TRUNCATE ") ||
    upper.includes(" TRUNCATE ")
  ) {
    return { isDestructive: true, op: "TRUNCATE TABLE" };
  }

  return { isDestructive: false, op: "" };
}

/**
 * Extracts table and column names from an ALTER TABLE ... ADD statement using tokenization.
 */
function extractTableAndColumn(statement: string): { tableName: string; columnName: string } {
  const words = statement.trim().split(/\s+/);
  let tableName = "table";
  let columnName = "column";

  for (let i = 0; i < words.length; i++) {
    const word = words[i]?.toUpperCase();
    if (word === "TABLE" && i + 1 < words.length) {
      let next = words[i + 1] ?? "";
      if (next.toUpperCase() === "ONLY" && i + 2 < words.length) {
        next = words[i + 2] ?? "";
      }
      tableName = next.replace(/["`]/g, "");
    }
    if (word === "ADD" && i + 1 < words.length) {
      let next = words[i + 1] ?? "";
      if (next.toUpperCase() === "COLUMN" && i + 2 < words.length) {
        next = words[i + 2] ?? "";
      }
      columnName = next.replace(/["`]/g, "");
    }
  }

  return { tableName, columnName };
}

/**
 * Inspects whether an ALTER TABLE statement adds a NOT NULL column without a DEFAULT.
 */
function inspectNotNullWithoutDefault(statement: string): {
  isUnsafe: boolean;
  tableName: string;
  columnName: string;
} {
  const upper = statement.toUpperCase();

  if (!upper.includes("ALTER TABLE")) {
    return { isUnsafe: false, tableName: "", columnName: "" };
  }

  const hasAdd = upper.includes(" ADD ") || upper.includes(" ADD\n") || upper.includes(" ADD\t");
  if (!hasAdd) {
    return { isUnsafe: false, tableName: "", columnName: "" };
  }

  const hasNotNull = upper.includes("NOT NULL");
  const hasDefault = upper.includes("DEFAULT");

  if (hasNotNull && !hasDefault) {
    const { tableName, columnName } = extractTableAndColumn(statement);
    return { isUnsafe: true, tableName, columnName };
  }

  return { isUnsafe: false, tableName: "", columnName: "" };
}

/**
 * Checks raw migration SQL text for forward-only policy compliance and zero-downtime safety.
 *
 * @param sql - Raw SQL content of the migration.
 * @param filePath - Path or identifier of the migration for reporting.
 * @returns MigrationCheckResult with all errors and warnings.
 */
export function checkMigrationSql(sql: string, filePath = "migration.sql"): MigrationCheckResult {
  const issues: MigrationSafetyIssue[] = [];
  const lines = sql.split(/\r?\n/);
  const hasDataPreservationNote = DATA_PRESERVATION_NOTE_PATTERN.test(sql);

  // Strip single-line comments for statement parsing while preserving line mapping
  const cleanedStatements: { text: string; startLine: number }[] = [];
  let currentStatement = "";
  let statementStartLine = 1;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (rawLine === undefined) {
      continue;
    }
    const lineNumber = i + 1;
    const trimmed = rawLine.trim();

    // Skip comment lines
    if (trimmed.startsWith("--") || trimmed.startsWith("/*")) {
      continue;
    }

    if (!currentStatement) {
      statementStartLine = lineNumber;
    }

    currentStatement += " " + rawLine;

    if (currentStatement.includes(";")) {
      const parts = currentStatement.split(";");
      for (let p = 0; p < parts.length - 1; p++) {
        const part = parts[p];
        if (part !== undefined) {
          cleanedStatements.push({
            text: part.trim(),
            startLine: statementStartLine,
          });
        }
      }
      currentStatement = (parts[parts.length - 1] ?? "").trim();
      statementStartLine = lineNumber;
    }
  }

  if (currentStatement.trim()) {
    cleanedStatements.push({
      text: currentStatement.trim(),
      startLine: statementStartLine,
    });
  }

  for (const stmt of cleanedStatements) {
    const text = stmt.text;

    // --- Issue 393: Forward-only policy (no undocumented destructive drops) ---
    const dropCheck = inspectDestructiveOperation(text);
    if (dropCheck.isDestructive) {
      if (!hasDataPreservationNote) {
        issues.push({
          rule: "forward-only-destructive-change",
          severity: "error",
          line: stmt.startLine,
          statement: text,
          message:
            `Destructive schema operation (${dropCheck.op}) detected without an accompanying data-preservation note. ` +
            `In accordance with Verixa's forward-only migration policy (Issue 393), destructive operations ` +
            `must include a documented data-preservation note (e.g. '-- DATA PRESERVATION: <archive strategy and rationale>') ` +
            `explaining why the drop is safe and how data was preserved or deprecated.`,
          guidance:
            "Add a comment block explaining the data archive, deprecation schedule, or data migration strategy before dropping tables or columns.",
        });
      }
    }

    // --- Issue 394: Zero-downtime rolling deploy checklist ---
    const notNullCheck = inspectNotNullWithoutDefault(text);
    if (notNullCheck.isUnsafe) {
      issues.push({
        rule: "zero-downtime-not-null-no-default",
        severity: "warning",
        line: stmt.startLine,
        statement: text,
        message:
          `Adding NOT NULL column "${notNullCheck.columnName}" to table "${notNullCheck.tableName}" without a DEFAULT in a single step ` +
          `breaks zero-downtime rolling deploys (Issue 394). Older running API replicas will fail when inserting ` +
          `rows without this column.`,
        guidance:
          `Split into the expand/contract pattern:\n` +
          `  Step 1 (Expand): Add "${notNullCheck.columnName}" as NULLABLE (or with a DEFAULT).\n` +
          `  Step 2 (Deploy): Release application code that populates and reads "${notNullCheck.columnName}".\n` +
          `  Step 3 (Backfill): Backfill existing NULL rows with valid values.\n` +
          `  Step 4 (Contract): Enforce NOT NULL in a later deploy via ALTER TABLE "${notNullCheck.tableName}" ALTER COLUMN "${notNullCheck.columnName}" SET NOT NULL.`,
      });
    }
  }

  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");

  return {
    filePath,
    passed: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Scans a migrations directory (containing subdirectories with migration.sql files).
 *
 * @param migrationsDir - Directory to scan (e.g., packages/database/prisma/migrations).
 * @returns Array of check results for all discovered migration.sql files.
 */
export function checkMigrationsDirectory(migrationsDir: string): MigrationCheckResult[] {
  const resolvedDir = resolve(migrationsDir);
  if (!existsSync(resolvedDir)) {
    throw new Error(`Migrations directory not found: ${resolvedDir}`);
  }

  const results: MigrationCheckResult[] = [];
  const entries = readdirSync(resolvedDir);

  for (const entry of entries) {
    const fullPath = join(resolvedDir, entry);
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      const sqlFile = join(fullPath, "migration.sql");
      if (existsSync(sqlFile)) {
        const content = readFileSync(sqlFile, "utf-8");
        results.push(checkMigrationSql(content, sqlFile));
      }
    } else if (entry.endsWith(".sql")) {
      const content = readFileSync(fullPath, "utf-8");
      results.push(checkMigrationSql(content, fullPath));
    }
  }

  return results;
}

/**
 * Runs the check across the default or specified migrations directory and computes a summary.
 */
export function runMigrationSafetyCheck(options: {
  migrationsDir?: string;
  strict?: boolean;
}): MigrationSafetySummary {
  const dir = options.migrationsDir ?? "packages/database/prisma/migrations";
  const results = checkMigrationsDirectory(dir);

  let totalErrors = 0;
  let totalWarnings = 0;

  for (const r of results) {
    totalErrors += r.errors.length;
    totalWarnings += r.warnings.length;
  }

  const passed = options.strict ? totalErrors === 0 && totalWarnings === 0 : totalErrors === 0;

  return {
    totalChecked: results.length,
    passed,
    results,
    totalErrors,
    totalWarnings,
  };
}

// CLI runner
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  let dir = "packages/database/prisma/migrations";
  let strict = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dir" && args[i + 1]) {
      dir = args[++i]!;
    } else if (arg === "--strict" || arg === "--fail-on-warning") {
      strict = true;
    }
  }

  console.log(`Checking migration safety in: ${dir}`);
  const summary = runMigrationSafetyCheck({ migrationsDir: dir, strict });

  console.log(`Checked ${summary.totalChecked} migration(s).`);

  for (const result of summary.results) {
    if (result.errors.length > 0 || result.warnings.length > 0) {
      console.log(`\nFile: ${result.filePath}`);
      for (const err of result.errors) {
        console.error(`  [ERROR] Line ${err.line}: ${err.message}`);
        if (err.guidance) {
          console.error(`    Guidance: ${err.guidance}`);
        }
      }
      for (const warn of result.warnings) {
        console.warn(`  [WARNING] Line ${warn.line}: ${warn.message}`);
        if (warn.guidance) {
          console.warn(`    Guidance:\n    ${warn.guidance.replace(/\n/g, "\n    ")}`);
        }
      }
    }
  }

  console.log(`\nSummary: ${summary.totalErrors} error(s), ${summary.totalWarnings} warning(s).`);

  if (!summary.passed) {
    console.error("Migration safety checks failed.");
    process.exit(1);
  } else {
    console.log("All migration safety checks passed.");
    process.exit(0);
  }
}
