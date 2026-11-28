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

/**
 * Kills mutants the mutation-testing spike found
 * surviving in get-users-by-organization-ids.ts.
 */
describe("GetUsersByOrganizationIds: memberships that must not produce a user", () => {
  const registered = (email: string) =>
    User.register({
      email: unwrap(Email.create(email)),
      displayName: unwrap(DisplayName.create(email.split("@")[0] ?? email)),
    });

  it("leaves out a user whose membership was revoked", async () => {
    // Kills :42 (the `status === "active"` filter replaced by `true`, or
    // removed): a user who left would still be listed as a member.
    const userRepo = new InMemoryUserRepository();
    const membershipRepo = new InMemoryOrganizationMembershipRepository();
    const member = registered("member@example.com");
    const former = registered("former@example.com");
    await userRepo.save(member);
    await userRepo.save(former);
    await membershipRepo.save(
      unwrap(OrganizationMembership.create({ userId: member.id, organizationId: ORG_1 })),
    );
    await membershipRepo.save(
      unwrap(OrganizationMembership.create({ userId: former.id, organizationId: ORG_1 })).revoke(),
    );

    const result = await new GetUsersByOrganizationIds(membershipRepo, userRepo).execute({
      organizationIds: [ORG_1],
    });

    expect(Result.isOk(result) && result.value.get(ORG_1)?.map((u) => u.id)).toEqual([member.id]);
  });

  it("skips a membership whose user no longer exists, rather than listing a hole", async () => {
    // Kills :54 (`user !== undefined` -> `true`), which would push `undefined`
    // into the organization's user list.
    const userRepo = new InMemoryUserRepository();
    const membershipRepo = new InMemoryOrganizationMembershipRepository();
    const member = registered("present@example.com");
    const missing = registered("missing@example.com");
    await userRepo.save(member);
    await membershipRepo.save(
      unwrap(OrganizationMembership.create({ userId: member.id, organizationId: ORG_2 })),
    );
    await membershipRepo.save(
      unwrap(OrganizationMembership.create({ userId: missing.id, organizationId: ORG_2 })),
    );

    const result = await new GetUsersByOrganizationIds(membershipRepo, userRepo).execute({
      organizationIds: [ORG_2],
    });

    expect(Result.isOk(result) && result.value.get(ORG_2)?.map((u) => u.id)).toEqual([member.id]);
  });
});
