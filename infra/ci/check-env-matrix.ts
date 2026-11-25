import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { getSchemaKeys } from "../../packages/config/schema.js";

export interface EnvMatrixEntry {
  readonly variable: string;
  readonly typeConstraints: string;
  readonly isSecret: boolean;
  readonly development: string;
  readonly test: string;
  readonly staging: string;
  readonly production: string;
  readonly description: string;
}

export interface MatrixValidationResult {
  readonly valid: boolean;
  readonly schemaKeys: readonly string[];
  readonly documentedKeys: readonly string[];
  readonly missingFromDocs: readonly string[];
  readonly undocumentedSecrets: readonly string[];
  readonly entries: readonly EnvMatrixEntry[];
}

/**
 * Parses markdown table entries from docs/guides/deployment.md
 */
export function parseDeploymentMatrix(markdownContent: string): EnvMatrixEntry[] {
  const lines = markdownContent.split("\n");
  const entries: EnvMatrixEntry[] = [];

  let inTable = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\|\s*`?Variable`?\s*\|/i.test(trimmed)) {
      inTable = true;
      continue;
    }

    if (inTable) {
      if (!trimmed.startsWith("|")) {
        // Table ended
        if (trimmed.startsWith("#") || trimmed.length === 0) {
          inTable = false;
        }
        continue;
      }

      // Skip separator row `| :--- |`
      if (/^\|\s*:?-+:?\s*\|/.test(trimmed)) {
        continue;
      }

      const columns = trimmed
        .split("|")
        .slice(1, -1)
        .map((col) => col.trim());

      if (columns.length >= 7) {
        const varCol = columns[0] ?? "";
        const match = /`([^`]+)`/.exec(varCol);
        if (match && match[1]) {
          const varName = match[1];
          const isSecret = (columns[2] ?? "").toLowerCase().includes("yes");
          entries.push({
            variable: varName,
            typeConstraints: columns[1] ?? "",
            isSecret,
            development: columns[3] ?? "",
            test: columns[4] ?? "",
            staging: columns[5] ?? "",
            production: columns[6] ?? "",
            description: columns[7] ?? "",
          });
        }
      }
    }
  }

  return entries;
}

/**
 * Validates that every variable in the config schema is documented in the matrix,
 * and that secrets are clearly flagged.
 */
export function validateEnvironmentMatrix(
  markdownContent: string,
  schemaKeys: readonly string[] = getSchemaKeys(),
): MatrixValidationResult {
  const entries = parseDeploymentMatrix(markdownContent);
  const documentedKeys = entries.map((e) => e.variable);

  const missingFromDocs = schemaKeys.filter((key) => !documentedKeys.includes(key));

  const knownSecrets = [
    "DATABASE_URL",
    "REDIS_URL",
    "SESSION_ACCESS_TOKEN_SECRET",
    "TOKEN_SIGNING_KEYS",
    "STELLAR_ANCHOR_SECRET_KEY",
    "MFA_ENCRYPTION_KEY",
  ];

  const undocumentedSecrets: string[] = [];
  for (const entry of entries) {
    if (knownSecrets.includes(entry.variable) && !entry.isSecret) {
      undocumentedSecrets.push(entry.variable);
    }
  }

  const valid = missingFromDocs.length === 0 && undocumentedSecrets.length === 0;

  return {
    valid,
    schemaKeys,
    documentedKeys,
    missingFromDocs,
    undocumentedSecrets,
    entries,
  };
}

/**
 * CLI execution entrypoint
 */
export async function runMatrixCheck(docsPath?: string): Promise<boolean> {
  const targetPath = docsPath ?? path.resolve(process.cwd(), "docs/guides/deployment.md");

  const markdownContent = await fs.readFile(targetPath, "utf-8");
  const result = validateEnvironmentMatrix(markdownContent);

  if (!result.valid) {
    console.error("Environment Configuration Matrix check failed!");
    if (result.missingFromDocs.length > 0) {
      console.error(
        `The following variables from packages/config/schema.ts are missing from ${targetPath}:`,
      );
      for (const key of result.missingFromDocs) {
        console.error(`  - ${key}`);
      }
    }
    if (result.undocumentedSecrets.length > 0) {
      console.error("The following sensitive variables must be flagged with Secret = Yes:");
      for (const key of result.undocumentedSecrets) {
        console.error(`  - ${key}`);
      }
    }
    return false;
  }

  console.log(
    `Environment configuration matrix in ${targetPath} is in sync with packages/config/schema.ts (${result.documentedKeys.length} variables verified).`,
  );
  return true;
}

if (
  process.argv[1] &&
  (import.meta.url === pathToFileURL(process.argv[1]).href ||
    process.argv[1].endsWith("check-env-matrix.ts") ||
    process.argv[1].endsWith("check-env-matrix.js"))
) {
  void runMatrixCheck().then((success) => {
    if (!success) {
      process.exit(1);
    }
  });
}
