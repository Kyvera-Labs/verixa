import { asId, Result } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import { OrganizationMembership, type OrganizationRole } from "./organization-membership.js";

const organizationId = asId<"OrganizationId">("org_1");
const userId = asId<"UserId">("user_1");

function member(role: OrganizationRole): OrganizationMembership {
  return OrganizationMembership.create({ organizationId, userId, role });
}

describe("OrganizationMembership", () => {
  it("starts active with a generated id", () => {
    const m = member("member");
    expect(m.active).toBe(true);
    expect(m.id).toBeTruthy();
    expect(m.role).toBe("member");
  });

  it.each<[OrganizationRole, OrganizationRole]>([
    ["owner", "admin"],
    ["owner", "owner"],
    ["admin", "admin"],
  ])("lets a(n) %s change a member to %s", (actor, role) => {
    const result = member("member").changeRole(actor, role, 2);
    expect(Result.isOk(result) && result.value.role).toBe(role);
  });

  it("does not let a plain member change roles", () => {
    expect(Result.isErr(member("member").changeRole("member", "admin", 2))).toBe(true);
  });

  it("only lets an owner grant the owner role", () => {
    expect(Result.isErr(member("admin").changeRole("admin", "owner", 2))).toBe(true);
  });

  it("refuses to demote the last owner", () => {
    expect(Result.isErr(member("owner").changeRole("owner", "admin", 1))).toBe(true);
    expect(Result.isOk(member("owner").changeRole("owner", "admin", 2))).toBe(true);
  });

  it("deactivates on removal by an owner or admin", () => {
    const result = member("member").remove("admin", 1);
    expect(Result.isOk(result) && result.value.active).toBe(false);
  });

  it("does not let a plain member remove anyone", () => {
    expect(Result.isErr(member("member").remove("member", 1))).toBe(true);
  });

  it("refuses to remove the last owner", () => {
    expect(Result.isErr(member("owner").remove("owner", 1))).toBe(true);
    expect(Result.isOk(member("owner").remove("owner", 2))).toBe(true);
  });

  it("does not mutate the original on a change", () => {
    const original = member("member");
    original.changeRole("owner", "admin", 2);
    expect(original.role).toBe("member");
  });

  it("reconstitutes a stored membership exactly as persisted", () => {
    const stored = OrganizationMembership.reconstitute({
      id: asId<"OrganizationMembershipId">("mem_1"),
      organizationId,
      userId,
      role: "admin",
      active: false,
    });
    expect(stored.id).toBe("mem_1");
    expect(stored.role).toBe("admin");
    expect(stored.active).toBe(false);
  });
});
