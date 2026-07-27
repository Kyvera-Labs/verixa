import { describe, expect, it } from "vitest";

import { asId, createId, type Id } from "./branded-id.js";

const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("createId", () => {
  it("generates a valid UUID v4 string", () => {
    const id = createId<"TestId">();

    expect(id).toMatch(uuidV4Pattern);
  });

  it("generates a different id on each call", () => {
    expect(createId<"TestId">()).not.toBe(createId<"TestId">());
  });
});

describe("asId", () => {
  it("brands an existing string without altering its runtime value", () => {
    const raw = "11111111-1111-4111-8111-111111111111";

    expect(asId<"TestId">(raw)).toBe(raw);
  });
});

describe("branding (compile-time)", () => {
  it("prevents one branded id kind from being used where another is required", () => {
    type UserId = Id<"UserId">;
    type OrganizationId = Id<"OrganizationId">;

    function requiresUserId(id: UserId): UserId {
      return id;
    }

    const organizationId: OrganizationId = createId<"OrganizationId">();

    // @ts-expect-error — an OrganizationId must not be assignable where a UserId is required.
    requiresUserId(organizationId);

    // Plain, unbranded strings must not be assignable either — that's the
    // whole point of branding over a bare `string` id.
    const plainString = "not-an-id";
    // @ts-expect-error — a bare string is not a UserId without going through asId/createId.
    requiresUserId(plainString);

    expect(true).toBe(true);
  });
});
