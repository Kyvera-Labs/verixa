import { asId, Result } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import type { OrganizationMembershipRepository } from "../../../application/ports/organization-membership-repository.js";
import { OrganizationMembership } from "../../../domain/entities/organization-membership.js";
import type { OrganizationId } from "../../../domain/entities/organization.js";
import type { UserId } from "../../../domain/entities/user.js";

const USER_ID = asId<"UserId">("00000000-0000-0000-0000-000000000001");
const ORGANIZATION_ID = asId<"OrganizationId">("00000000-0000-0000-0000-000000000002");

function makeMembership(userId: UserId, organizationId: OrganizationId): OrganizationMembership {
  const result = OrganizationMembership.create({ userId, organizationId });
  if (!Result.isOk(result)) {
    throw new Error("contract test fixture setup failed");
  }
  return result.value;
}

/** Behavioral contract every `OrganizationMembershipRepository` implementation must satisfy. See `user-repository.contract.ts`. */
export function organizationMembershipRepositoryContract(
  createRepository: () => OrganizationMembershipRepository,
): void {
  describe("OrganizationMembershipRepository contract", () => {
    it("returns undefined when no active membership exists for the pair", async () => {
      const repository = createRepository();

      await expect(
        repository.findActiveByUserAndOrganization(USER_ID, ORGANIZATION_ID),
      ).resolves.toBeUndefined();
    });

    it("finds an active membership by user and organization", async () => {
      const repository = createRepository();
      const membership = makeMembership(USER_ID, ORGANIZATION_ID);

      await repository.save(membership);

      await expect(
        repository.findActiveByUserAndOrganization(USER_ID, ORGANIZATION_ID),
      ).resolves.toBe(membership);
    });

    it("does not return a revoked membership as active", async () => {
      const repository = createRepository();
      const membership = makeMembership(USER_ID, ORGANIZATION_ID).revoke();

      await repository.save(membership);

      await expect(
        repository.findActiveByUserAndOrganization(USER_ID, ORGANIZATION_ID),
      ).resolves.toBeUndefined();
    });

    it("finds all memberships (active and revoked) for an organization", async () => {
      const repository = createRepository();
      const otherUserId = asId<"UserId">("00000000-0000-0000-0000-000000000003");
      const active = makeMembership(USER_ID, ORGANIZATION_ID);
      const revoked = makeMembership(otherUserId, ORGANIZATION_ID).revoke();

      await repository.save(active);
      await repository.save(revoked);

      const all = await repository.findAllByOrganization(ORGANIZATION_ID);
      expect(all).toHaveLength(2);
    });
  });
}
