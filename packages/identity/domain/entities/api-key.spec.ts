import { Result } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";
import { ApiKey, type ApiKeyStatus } from "../entities/api-key.js";

describe("ApiKey", () => {
  it("creates an ApiKey with prefix vx_ and hashed key", () => {
    const result = ApiKey.create({
      name: "test-key",
      organizationId: "org-1" as any,
      scopes: ["audit:query", "audit:export"],
    });

    expect(Result.isOk(result)).toBe(true);
    if (!Result.isOk(result)) return;

    const { apiKey, rawKey } = result.value;
    expect(rawKey.startsWith("vx_")).toBe(true);
    expect(apiKey.name).toBe("test-key");
    expect(apiKey.keyPreview).toBe(rawKey.slice(-4));
    expect(apiKey.keyHash).toBe(ApiKey.hashKey(rawKey));
    expect(apiKey.scopes).toEqual(["audit:query", "audit:export"]);
    expect(apiKey.status).toBe("active");
    expect(apiKey.isActive()).toBe(true);
  });

  it("verifies candidate raw key in constant time", () => {
    const result = ApiKey.create({
      name: "test-key",
      organizationId: "org-1" as any,
    });
    if (!Result.isOk(result)) return;

    const { apiKey, rawKey } = result.value;
    expect(apiKey.matchesKey(rawKey)).toBe(true);
    expect(apiKey.matchesKey("vx_wrong_key")).toBe(false);
  });

  it("handles revocation and expiration status correctly", () => {
    const result = ApiKey.create({
      name: "test-key",
      organizationId: "org-1" as any,
      expiresAt: new Date(Date.now() + 10_000),
    });
    if (!Result.isOk(result)) return;

    const { apiKey } = result.value;
    expect(apiKey.isActive()).toBe(true);

    const revoked = apiKey.revoke();
    expect(revoked.status).toBe("revoked");
    expect(revoked.isActive()).toBe(false);

    // Expired in past
    const past = new Date(Date.now() + 20_000);
    expect(apiKey.isActive(past)).toBe(false);
  });

  it("rejects empty name or invalid expiration date", () => {
    const emptyName = ApiKey.create({
      name: "   ",
      organizationId: "org-1" as any,
    });
    expect(Result.isErr(emptyName)).toBe(true);

    const pastExpiry = ApiKey.create({
      name: "valid-name",
      organizationId: "org-1" as any,
      expiresAt: new Date(Date.now() - 10_000),
    });
    expect(Result.isErr(pastExpiry)).toBe(true);
  });
});
