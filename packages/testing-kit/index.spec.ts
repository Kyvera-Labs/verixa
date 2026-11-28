import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

import * as testingKit from "./index.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

describe("@verixa/testing-kit public API (Issue 420)", () => {
  it("does not expose the package's internal helpers", () => {
    // Runtime values, checked by name. Both were reachable through the old
    // `export * from "./factories/index.js"`: `unwrapResult` wraps a domain
    // error in a generic one, which is right for a factory default and wrong
    // for a test asserting on the domain's error, and `orThrowDomainError` is
    // the builders' private step helper.
    expect(testingKit).not.toHaveProperty("unwrapResult");
    expect(testingKit).not.toHaveProperty("orThrowDomainError");
  });
});

/**
 * Runs the repository's real ESLint configuration, so what is verified is the
 * rule contributors actually hit, not a copy of it that could drift. Same
 * shape as the boundary test in packages/audit/index.spec.ts.
 *
 * Linted as the text of files that exist on disk, because the configuration is
 * type-aware and the TypeScript project service only knows files that belong
 * to a project.
 */
describe("deep-import boundary rule for @verixa/testing-kit", () => {
  const eslint = new ESLint({ cwd: repositoryRoot });

  async function boundaryViolations(code: string, filePath: string): Promise<string[]> {
    const [result] = await eslint.lintText(code, { filePath: `${repositoryRoot}${filePath}` });
    return (result?.messages ?? [])
      .filter((message) => message.ruleId === "no-restricted-imports")
      .map((message) => message.message);
  }

  it("rejects a deep import from another package", async () => {
    const violations = await boundaryViolations(
      'export { makeUser } from "@verixa/testing-kit/factories/user.js";\n',
      "packages/notifications/infrastructure/testing/notification-sender.contract.spec.ts",
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("`@verixa/testing-kit`");
  });

  it("rejects a deep import from the integration suite, which is exempt for context packages", async () => {
    const violations = await boundaryViolations(
      'export { aCredential } from "@verixa/testing-kit/builders/credential.js";\n',
      "tests/examples/approve-verification.spec.ts",
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("`@verixa/testing-kit`");
  });

  it("still lets the integration suite deep-import a context package", async () => {
    const violations = await boundaryViolations(
      'export { AuditLogEntry } from "@verixa/audit/domain/entities/audit-log-entry.js";\n',
      "tests/examples/approve-verification.spec.ts",
    );

    expect(violations).toEqual([]);
  });

  it("allows importing from the package root", async () => {
    const violations = await boundaryViolations(
      'export { aCredential, makeUser } from "@verixa/testing-kit";\n',
      "packages/notifications/infrastructure/testing/notification-sender.contract.spec.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not apply inside the testing-kit package itself", async () => {
    const violations = await boundaryViolations(
      'export { unwrapResult } from "./factories/result-helper.js";\n' +
        'export { makeUser } from "@verixa/testing-kit/factories/user.js";\n',
      "packages/testing-kit/index.ts",
    );

    expect(violations).toEqual([]);
  });
}, 120_000);
