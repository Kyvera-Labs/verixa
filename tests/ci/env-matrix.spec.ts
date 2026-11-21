import { promises as fs } from "node:fs";
import path from "node:path";

import { getSchemaKeys } from "@verixa/config/schema";
import { describe, expect, it } from "vitest";

import { REPO_ROOT, runCheckEnvMatrix } from "./helpers/ci-tooling.js";

const docsPath = path.resolve(REPO_ROOT, "docs/guides/deployment.md");

describe("Environment Configuration Matrix (Issue 389)", () => {
  it("verifies that docs/guides/deployment.md contains all schema keys from packages/config", async () => {
    const content = await fs.readFile(docsPath, "utf-8");
    const schemaKeys = getSchemaKeys();

    for (const key of schemaKeys) {
      expect(content).toContain(`\`${key}\``);
    }
  });

  it("verifies that known secrets are clearly flagged in the documentation table", async () => {
    const content = await fs.readFile(docsPath, "utf-8");

    const sensitiveVars = ["DATABASE_URL", "REDIS_URL", "SESSION_ACCESS_TOKEN_SECRET"];

    for (const secretVar of sensitiveVars) {
      const line = content.split("\n").find((l) => l.includes(`\`${secretVar}\``));
      expect(line).toBeDefined();
      expect(line).toMatch(/\|\s*Yes\s*\|/);
    }
  });

  it("runs the CI check-env-matrix tool as a subprocess and asserts exitCode 0", () => {
    const result = runCheckEnvMatrix();
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("is in sync with packages/config/schema.ts");
  });
});
