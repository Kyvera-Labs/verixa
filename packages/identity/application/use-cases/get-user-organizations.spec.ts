import { asId, Result } from "@verixa/shared-kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { OrganizationMembership } from "../../domain/entities/organization-membership.js";
import { Organization } from "../../domain/entities/organization.js";
import type { UserId } from "../../domain/entities/user.js";
import { InMemoryOrganizationMembershipRepository } from "../../infrastructure/testing/in-memory-organization-membership-repository.js";
import { InMemoryOrganizationRepository } from "../../infrastructure/testing/in-memory-organization-repository.js";

import { GetUserOrganizations } from "./get-user-organizations.js";

const USER_ID: UserId = asId("00000000-0000-0000-0000-000000000001");

function unwrap<T>(result: Result<T, unknown>): T {
  if (!Result.isOk(result)) {
    throw new Error("Fixture unwrapping failed");
  }
  return result.value;
}

describe("GetUserOrganizations", () => {
  let orgRepo: InMemoryOrganizationRepository;
  let membershipRepo: InMemoryOrganizationMembershipRepository;
  let getUserOrganizations: GetUserOrganizations;

  beforeEach(() => {
    orgRepo = new InMemoryOrganizationRepository();
    membershipRepo = new InMemoryOrganizationMembershipRepository();
    getUserOrganizations = new GetUserOrganizations(membershipRepo, orgRepo);
  });

  it("returns all active organizations for a user", async () => {
    const org1 = unwrap(
      Organization.create({
        name: "Org 1",
        slug: "org-1",
        ownerId: USER_ID,
      }),
    );
    const org2 = unwrap(
      Organization.create({
        name: "Org 2",
        slug: "org-2",
        ownerId: USER_ID,
      }),
    );

    await orgRepo.save(org1);
    await orgRepo.save(org2);

    const m1 = unwrap(
      OrganizationMembership.create({
        userId: USER_ID,
        organizationId: org1.id,
      }),
    );
    const m2 = unwrap(
      OrganizationMembership.create({
        userId: USER_ID,
        organizationId: org2.id,
      }),
    );

    await membershipRepo.save(m1);
    await membershipRepo.save(m2);

    const result = await getUserOrganizations.execute({ userId: USER_ID });

    expect(Result.isOk(result)).toBe(true);
    expect(Result.isOk(result) && result.value).toHaveLength(2);
  });
});

/**
 * Added in Issue 417: kills the mutants at get-user-organizations.ts:26 that
 * the mutation-testing spike found surviving (the `status === "active"`
 * filter replaced by `true`, or removed). Every existing test used only
 * active memberships, so dropping the filter changed nothing they checked.
 */
describe("GetUserOrganizations: revoked memberships", () => {
  it("does not list an organization the user's membership was revoked from", async () => {
    const orgRepo = new InMemoryOrganizationRepository();
    const membershipRepo = new InMemoryOrganizationMembershipRepository();
    const kept = unwrap(Organization.create({ name: "Kept", slug: "kept", ownerId: USER_ID }));
    const left = unwrap(Organization.create({ name: "Left", slug: "left", ownerId: USER_ID }));
    await orgRepo.save(kept);
    await orgRepo.save(left);
    await membershipRepo.save(
      unwrap(OrganizationMembership.create({ userId: USER_ID, organizationId: kept.id })),
    );
    await membershipRepo.save(
      unwrap(OrganizationMembership.create({ userId: USER_ID, organizationId: left.id })).revoke(),
    );

    const result = await new GetUserOrganizations(membershipRepo, orgRepo).execute({
      userId: USER_ID,
    });

    expect(Result.isOk(result) && result.value.map((o) => o.id)).toEqual([kept.id]);
  });
});
