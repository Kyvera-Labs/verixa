import { describe, expect, it } from "vitest";

import {
  assertValidTenantId,
  TENANT_CONTEXT_MECHANISM,
  TENANT_CONTEXT_SETTING,
} from "./tenant-context.js";

describe("Tenant Context (shared-kernel)", () => {
  it("exposes the expected setting name and mechanism", () => {
    expect(TENANT_CONTEXT_SETTING).toBe("app.current_organization_id");
    expect(TENANT_CONTEXT_MECHANISM).toBe("set_config(is_local => true)");
  });

  it("accepts valid non-empty organization ids", () => {
    expect(() => assertValidTenantId("org-12345")).not.toThrow();
    expect(() => assertValidTenantId("00000000-0000-0000-0000-000000000001")).not.toThrow();
  });

  it("throws when organization id is empty or whitespace only", () => {
    expect(() => assertValidTenantId("")).toThrow(
      /Tenant context requires a non-empty organization id/,
    );
    expect(() => assertValidTenantId("   ")).toThrow(
      /Tenant context requires a non-empty organization id/,
    );
  });
});
