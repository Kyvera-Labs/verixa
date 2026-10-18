import { asId, Result } from "@verixa/shared-kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { OrganizationMembership } from "../../domain/entities/organization-membership.js";
import type { OrganizationId } from "../../domain/entities/organization.js";
import { User } from "../../domain/entities/user.js";
import { DisplayName } from "../../domain/value-objects/display-name.js";
import { Email } from "../../domain/value-objects/email.js";
import { InMemoryOrganizationMembershipRepository } from "../../infrastructure/testing/in-memory-organization-membership-repository.js";
import { InMemoryUserRepository } from "../../infrastructure/testing/in-memory-user-repository.js";

import { GetOrganizationUsers } from "./get-organization-users.js";

const ORG_ID: OrganizationId = asId("00000000-0000-0000-0000-000000000001");

function unwrap<T>(result: Result<T, unknown>): T {
  if (!Result.isOk(result)) {
    throw new Error("Fixture unwrapping failed");
  }
  return result.value;
}

describe("GetOrganizationUsers", () => {
  let userRepo: InMemoryUserRepository;
  let membershipRepo: InMemoryOrganizationMembershipRepository;
  let getOrganizationUsers: GetOrganizationUsers;

  beforeEach(() => {
    userRepo = new InMemoryUserRepository();
    membershipRepo = new InMemoryOrganizationMembershipRepository();
    getOrganizationUsers = new GetOrganizationUsers(membershipRepo, userRepo);
  });

  it("returns all active users in an organization in batch", async () => {
    const user1 = User.register({
      email: unwrap(Email.create("u1@example.com")),
      displayName: unwrap(DisplayName.create("User 1")),
    });
    const user2 = User.register({
      email: unwrap(Email.create("u2@example.com")),
      displayName: unwrap(DisplayName.create("User 2")),
    });
    const user3 = User.register({
      email: unwrap(Email.create("u3@example.com")),
      displayName: unwrap(DisplayName.create("User 3")),
    });

    await userRepo.save(user1);
    await userRepo.save(user2);
    await userRepo.save(user3);

    const m1 = unwrap(
      OrganizationMembership.create({
        userId: user1.id,
        organizationId: ORG_ID,
      }),
    );

    const m2 = unwrap(
      OrganizationMembership.create({
        userId: user2.id,
        organizationId: ORG_ID,
      }),
    );

    // user3 has revoked membership
    const m3 = unwrap(
      OrganizationMembership.create({
        userId: user3.id,
        organizationId: ORG_ID,
      }),
    ).revoke();

    await membershipRepo.save(m1);
    await membershipRepo.save(m2);
    await membershipRepo.save(m3);

    const result = await getOrganizationUsers.execute({ organizationId: ORG_ID });

    expect(Result.isOk(result)).toBe(true);
    if (!Result.isOk(result)) throw new Error("unreachable");
    const users = result.value;
    expect(users).toHaveLength(2);
    const ids = users.map((u: User) => u.id);
    expect(ids).toContain(user1.id);
    expect(ids).toContain(user2.id);
    expect(ids).not.toContain(user3.id);
  });

  it("returns empty array when organization has no active members", async () => {
    const missingOrgId: OrganizationId = asId("00000000-0000-0000-0000-000000000099");
    const result = await getOrganizationUsers.execute({ organizationId: missingOrgId });

    expect(Result.isOk(result)).toBe(true);
    expect(Result.isOk(result) && result.value).toEqual([]);
  });
});
