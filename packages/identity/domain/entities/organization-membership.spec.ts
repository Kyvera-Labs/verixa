import { createId, Result } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import { OrganizationMembership } from "./organization-membership.js";
import type { OrganizationId } from "./organization.js";
import type { UserId } from "./user.js";

const userId = createId<"UserId">() as UserId;
const organizationId = createId<"OrganizationId">() as OrganizationId;

describe("OrganizationMembership", () => {
  it("creates an active membership", () => {
    const result = OrganizationMembership.create({ userId, organizationId });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.status).toBe("active");
      expect(result.value.userId).toBe(userId);
      expect(result.value.organizationId).toBe(organizationId);
    }
  });

  it("rejects a duplicate active membership for the same user+org pair", () => {
    const first = OrganizationMembership.create({ userId, organizationId });
    if (!Result.isOk(first)) throw new Error("fixture setup failed");

    const second = OrganizationMembership.create({
      userId,
      organizationId,
      existingMemberships: [first.value],
    });

    expect(Result.isErr(second)).toBe(true);
  });

  it("allows a new membership once the prior one is revoked", () => {
    const first = OrganizationMembership.create({ userId, organizationId });
    if (!Result.isOk(first)) throw new Error("fixture setup failed");
    const revoked = first.value.revoke();

    const second = OrganizationMembership.create({
      userId,
      organizationId,
      existingMemberships: [revoked],
    });

    expect(Result.isOk(second)).toBe(true);
  });

  it("does not conflict with memberships for a different user or organization", () => {
    const first = OrganizationMembership.create({ userId, organizationId });
    if (!Result.isOk(first)) throw new Error("fixture setup failed");

    const otherUser = createId<"UserId">() as UserId;
    const second = OrganizationMembership.create({
      userId: otherUser,
      organizationId,
      existingMemberships: [first.value],
    });

    expect(Result.isOk(second)).toBe(true);
  });

  it("revoke is idempotent", () => {
    const created = OrganizationMembership.create({ userId, organizationId });
    if (!Result.isOk(created)) throw new Error("fixture setup failed");

    const revokedOnce = created.value.revoke();
    const revokedTwice = revokedOnce.revoke();

    expect(revokedOnce.status).toBe("revoked");
    expect(revokedTwice).toBe(revokedOnce);
  });
});
