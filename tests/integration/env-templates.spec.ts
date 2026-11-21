import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "@verixa/config";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx !== -1) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      result[key] = val;
    }
  }

  return result;
}

describe("Environment Configuration Templates (Issue 390)", () => {
  const templateFiles = [
    ".env.example",
    ".env.test.example",
    ".env.staging.example",
    ".env.production.example",
  ];

  for (const fileName of templateFiles) {
    describe(`Template: ${fileName}`, () => {
      const filePath = path.resolve(repoRoot, fileName);

      it("exists on disk", async () => {
        const stat = await fs.stat(filePath);
        expect(stat.isFile()).toBe(true);
      });

      it("contains a header cross-referencing docs/guides/deployment.md (Issue 389)", async () => {
        const content = await fs.readFile(filePath, "utf-8");
        expect(content).toContain("docs/guides/deployment.md");
      });

      it("does not commit real secrets or credentials", async () => {
        const content = await fs.readFile(filePath, "utf-8");
        const parsed = parseEnvFile(content);

        // Ensure sensitive secrets are placeholders or local docker development credentials
        if (parsed.SESSION_ACCESS_TOKEN_SECRET) {
          expect(
            parsed.SESSION_ACCESS_TOKEN_SECRET.startsWith("change-this") ||
              parsed.SESSION_ACCESS_TOKEN_SECRET.startsWith("test-session-secret"),
          ).toBe(true);
        }

        if (parsed.DATABASE_URL && fileName.includes("production")) {
          expect(parsed.DATABASE_URL).toContain("prod_db_password_placeholder");
        }
      });

      it("loads and validates successfully through @verixa/config loadConfig", async () => {
        const content = await fs.readFile(filePath, "utf-8");
        const parsed = parseEnvFile(content);

        // Should parse and validate without throwing ConfigError
        const config = loadConfig(parsed);
        expect(config).toBeDefined();
        expect(typeof config.PORT).toBe("number");
        expect(typeof config.NODE_ENV).toBe("string");
      });
    });
  }
});
