import { asId, Result } from "@verixa/shared-kernel";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiKey } from "./api-key.js";

const ORG_ID = asId<"OrganizationId">("org-1");

describe("ApiKey", () => {
  it("creates an ApiKey with prefix vx_ and hashed key", () => {
    const result = ApiKey.create({
      name: "test-key",
      organizationId: ORG_ID,
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
      organizationId: ORG_ID,
    });
    if (!Result.isOk(result)) return;

    const { apiKey, rawKey } = result.value;
    expect(apiKey.matchesKey(rawKey)).toBe(true);
    expect(apiKey.matchesKey("vx_wrong_key")).toBe(false);
  });

  it("handles revocation and expiration status correctly", () => {
    const result = ApiKey.create({
      name: "test-key",
      organizationId: ORG_ID,
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
      organizationId: ORG_ID,
    });
    expect(Result.isErr(emptyName)).toBe(true);

    const pastExpiry = ApiKey.create({
      name: "valid-name",
      organizationId: ORG_ID,
      expiresAt: new Date(Date.now() - 10_000),
    });
    expect(Result.isErr(pastExpiry)).toBe(true);
  });
});

/**
 * Added in Issue 417: kills mutants the mutation-testing spike found surviving
 * in api-key.ts. Expiry was tested well before and well after, never at the
 * instant itself, which is where `<` and `<=` disagree.
 */
describe("ApiKey: expiry at the exact instant, defaults, and idempotent revoke", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("refuses to create a key that expires right now", () => {
    // Kills :93 (`<=` -> `<`).
    vi.useFakeTimers({ now: new Date("2026-06-01T12:00:00.000Z") });
    const result = ApiKey.create({ name: "ci", organizationId: ORG_ID, expiresAt: new Date() });
    expect(Result.isErr(result)).toBe(true);
  });

  it("creates a key with a future expiry", () => {
    // Kills :93 (the expiry comparison -> `true`, refusing every expiry).
    const result = ApiKey.create({
      name: "ci",
      organizationId: ORG_ID,
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(Result.isOk(result)).toBe(true);
  });

  it("is no longer active at the exact instant it expires", () => {
    // Kills :142 (`<=` -> `<`): a key must not work for one more millisecond.
    const expiresAt = new Date(Date.now() + 60_000);
    const result = ApiKey.create({ name: "ci", organizationId: ORG_ID, expiresAt });
    if (!Result.isOk(result)) throw new Error("fixture setup failed");
    expect(result.value.apiKey.isActive(new Date(expiresAt.getTime()))).toBe(false);
  });

  it("defaults to no scopes and records the creation event", () => {
    // Kills :103 (the `?? []` default replaced) and :116 (the ApiKeyCreated
    // event list emptied): the audit trail depends on that event.
    const result = ApiKey.create({ name: "ci", organizationId: ORG_ID });
    if (!Result.isOk(result)) throw new Error("fixture setup failed");
    expect(result.value.apiKey.scopes).toEqual([]);
    expect(result.value.apiKey.pullDomainEvents().map((e) => e.eventName)).toEqual([
      "identity.api_key.created",
    ]);
  });

  it("returns the same key when revoking one that is already revoked", () => {
    // Kills :150 (the already-revoked guard -> `false`), which would stamp a
    // new revokedAt and look like a second revocation.
    const result = ApiKey.create({ name: "ci", organizationId: ORG_ID });
    if (!Result.isOk(result)) throw new Error("fixture setup failed");
    const revoked = result.value.apiKey.revoke();
    expect(revoked.revoke()).toBe(revoked);
  });
});
