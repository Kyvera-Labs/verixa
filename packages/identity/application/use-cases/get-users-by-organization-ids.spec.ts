import { asId, Result } from "@verixa/shared-kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { OrganizationMembership } from "../../domain/entities/organization-membership.js";
import type { OrganizationId } from "../../domain/entities/organization.js";
import { User } from "../../domain/entities/user.js";
import { DisplayName } from "../../domain/value-objects/display-name.js";
import { Email } from "../../domain/value-objects/email.js";
import { InMemoryOrganizationMembershipRepository } from "../../infrastructure/testing/in-memory-organization-membership-repository.js";
import { InMemoryUserRepository } from "../../infrastructure/testing/in-memory-user-repository.js";

import { GetUsersByOrganizationIds } from "./get-users-by-organization-ids.js";

const ORG_1: OrganizationId = asId("00000000-0000-0000-0000-000000000001");
const ORG_2: OrganizationId = asId("00000000-0000-0000-0000-000000000002");

function unwrap<T>(result: Result<T, unknown>): T {
  if (!Result.isOk(result)) {
    throw new Error("Fixture unwrapping failed");
  }
  return result.value;
}

describe("GetUsersByOrganizationIds", () => {
  let userRepo: InMemoryUserRepository;
  let membershipRepo: InMemoryOrganizationMembershipRepository;
  let getUsersByOrganizationIds: GetUsersByOrganizationIds;

  beforeEach(() => {
    userRepo = new InMemoryUserRepository();
    membershipRepo = new InMemoryOrganizationMembershipRepository();
    getUsersByOrganizationIds = new GetUsersByOrganizationIds(membershipRepo, userRepo);
  });

  it("batches users across multiple organizations", async () => {
    const user1 = User.register({
      email: unwrap(Email.create("u1@example.com")),
      displayName: unwrap(DisplayName.create("User 1")),
    });
    const user2 = User.register({
      email: unwrap(Email.create("u2@example.com")),
      displayName: unwrap(DisplayName.create("User 2")),
    });

    await userRepo.save(user1);
    await userRepo.save(user2);

    await membershipRepo.save(
      unwrap(OrganizationMembership.create({ userId: user1.id, organizationId: ORG_1 })),
    );
    await membershipRepo.save(
      unwrap(OrganizationMembership.create({ userId: user2.id, organizationId: ORG_2 })),
    );

    const result = await getUsersByOrganizationIds.execute({
      organizationIds: [ORG_1, ORG_2],
    });

    expect(Result.isOk(result)).toBe(true);
    if (!Result.isOk(result)) throw new Error("unreachable");
    const map = result.value;
    expect(map.get(ORG_1)).toHaveLength(1);
    expect(map.get(ORG_1)?.[0]?.id).toBe(user1.id);
    expect(map.get(ORG_2)).toHaveLength(1);
    expect(map.get(ORG_2)?.[0]?.id).toBe(user2.id);
  });
});
