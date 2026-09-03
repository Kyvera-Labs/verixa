import { asId, Result } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import type { OrganizationRepository } from "../../../application/ports/organization-repository.js";
import { Organization } from "../../../domain/entities/organization.js";

function makeOrganization(slug: string): Organization {
  const result = Organization.create({
    name: "Acme Inc",
    slug,
    ownerId: asId<"UserId">("00000000-0000-0000-0000-000000000001"),
  });
  if (!Result.isOk(result)) {
    throw new Error("contract test fixture setup failed");
  }
  return result.value;
}

/** Behavioral contract every `OrganizationRepository` implementation must satisfy. See `user-repository.contract.ts`. */
export function organizationRepositoryContract(
  createRepository: () => OrganizationRepository,
): void {
  describe("OrganizationRepository contract", () => {
    it("returns undefined for an organization that was never saved", async () => {
      const repository = createRepository();

      await expect(repository.findById(makeOrganization("nobody").id)).resolves.toBeUndefined();
    });

    it("finds a saved organization by id", async () => {
      const repository = createRepository();
      const organization = makeOrganization("acme");

      await repository.save(organization);

      const found = await repository.findById(organization.id);

      // State, not identity — see the note in user-repository.contract.ts.
      expect(found?.id).toBe(organization.id);
      expect(found?.slug).toBe(organization.slug);
      expect(found?.name).toBe(organization.name);
      expect(found?.ownerId).toBe(organization.ownerId);
    });

    it("finds a saved organization by slug", async () => {
      const repository = createRepository();
      const organization = makeOrganization("acme");

      await repository.save(organization);

      const found = await repository.findBySlug("acme");

      expect(found?.id).toBe(organization.id);
      expect(found?.slug).toBe("acme");
    });

    it("existsBySlug is true only after the matching organization is saved", async () => {
      const repository = createRepository();
      const organization = makeOrganization("acme");

      await expect(repository.existsBySlug("acme")).resolves.toBe(false);
      await repository.save(organization);
      await expect(repository.existsBySlug("acme")).resolves.toBe(true);
    });
  });
}
