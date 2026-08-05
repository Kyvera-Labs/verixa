import { asId, Result } from "@verixa/shared-kernel";
import { beforeEach, describe, expect, it } from "vitest";

import type { UserId } from "../../domain/entities/user.js";
import { InMemoryOrganizationMembershipRepository } from "../../infrastructure/testing/in-memory-organization-membership-repository.js";
import { InMemoryOrganizationRepository } from "../../infrastructure/testing/in-memory-organization-repository.js";

import { CreateOrganization } from "./create-organization.js";

const OWNER_ID: UserId = asId("00000000-0000-0000-0000-000000000001");

describe("CreateOrganization", () => {
  let organizationRepository: InMemoryOrganizationRepository;
  let membershipRepository: InMemoryOrganizationMembershipRepository;
  let createOrganization: CreateOrganization;

  beforeEach(() => {
    organizationRepository = new InMemoryOrganizationRepository();
    membershipRepository = new InMemoryOrganizationMembershipRepository();
    createOrganization = new CreateOrganization(organizationRepository, membershipRepository);
  });

  it("creates the organization and an active owner membership together", async () => {
    const result = await createOrganization.execute({
      name: "Acme Inc",
      slug: "acme",
      ownerId: OWNER_ID,
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.organization.slug).toBe("acme");
      expect(result.value.membership.userId).toBe(OWNER_ID);
      expect(result.value.membership.organizationId).toBe(result.value.organization.id);
      expect(result.value.membership.status).toBe("active");
    }

    await expect(organizationRepository.findBySlug("acme")).resolves.toBeDefined();
    const memberships = await membershipRepository.findAllByOrganization(
      Result.isOk(result) ? result.value.organization.id : asId("unreachable"),
    );
    expect(memberships).toHaveLength(1);
  });

  it("rejects a duplicate slug without creating anything", async () => {
    const first = await createOrganization.execute({
      name: "Acme Inc",
      slug: "acme",
      ownerId: OWNER_ID,
    });
    expect(Result.isOk(first)).toBe(true);

    const second = await createOrganization.execute({
      name: "Acme Two",
      slug: "ACME",
      ownerId: asId("00000000-0000-0000-0000-000000000002"),
    });

    expect(Result.isErr(second)).toBe(true);
    if (Result.isErr(second)) {
      expect(second.error.code).toBe("CONFLICT");
    }
  });

  it("rejects an invalid slug without creating a membership", async () => {
    const result = await createOrganization.execute({
      name: "Acme Inc",
      slug: "a",
      ownerId: OWNER_ID,
    });

    expect(Result.isErr(result)).toBe(true);
    await expect(organizationRepository.existsBySlug("a")).resolves.toBe(false);
  });
});
