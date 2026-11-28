import { describe, expect, it } from "vitest";

import { assertValidTenantId, TENANT_CONTEXT_SETTING } from "./tenant-context.js";

/**
 * The mutation-testing spike found this module with no
 * direct tests (every mutant "no coverage"), although it is the guard that
 * keeps an empty tenant id from silently matching zero rows under RLS.
 */
describe("tenant context", () => {
  it("names the setting the RLS policies read", () => {
    // Kills the StringLiteral mutant on TENANT_CONTEXT_SETTING. The value is
    // a contract with SQL, not a label: the policies in
    // packages/database/prisma/migrations/*_enable_row_level_security read
    // exactly this name, and any other value would leave every tenant-scoped
    // query with no tenant. (The migration is not read from here because
    // Stryker's sandbox contains only this package.)
    expect(TENANT_CONTEXT_SETTING).toBe("app.current_organization_id");
  });

  describe("assertValidTenantId", () => {
    it("accepts a non-empty organization id", () => {
      // Kills `if (...) {` -> `if (true) {`.
      expect(() => {
        assertValidTenantId("6f1c2d7e-0000-4000-8000-000000000001");
      }).not.toThrow();
    });

    it("rejects an empty id, saying why", () => {
      // Kills the condition -> false, `=== ""` -> `!== ""`, the emptied block,
      // and both StringLiteral mutants in the message.
      expect(() => {
        assertValidTenantId("");
      }).toThrow(
        "Tenant context requires a non-empty organization id. An empty value would " +
          "leave RLS with no tenant and silently match zero rows.",
      );
    });

    it("rejects a whitespace-only id, which is empty once trimmed", () => {
      // Kills the MethodExpression mutant that drops `.trim()`.
      expect(() => {
        assertValidTenantId("   ");
      }).toThrow("non-empty organization id");
    });
  });
});
