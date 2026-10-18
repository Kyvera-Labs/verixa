import { asId, Result } from "@verixa/shared-kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { Organization, type OrganizationId } from "../../domain/entities/organization.js";
import type { UserId } from "../../domain/entities/user.js";
import { InMemoryOrganizationRepository } from "../../infrastructure/testing/in-memory-organization-repository.js";

import { GetOrganization } from "./get-organization.js";

const OWNER_ID: UserId = asId("00000000-0000-0000-0000-000000000001");

function unwrap<T>(result: Result<T, unknown>): T {
  if (!Result.isOk(result)) {
    throw new Error("Fixture unwrapping failed");
  }
  return result.value;
}

describe("GetOrganization", () => {
  let orgRepo: InMemoryOrganizationRepository;
  let getOrganization: GetOrganization;

  beforeEach(() => {
    orgRepo = new InMemoryOrganizationRepository();
    getOrganization = new GetOrganization(orgRepo);
  });

  it("finds organization by id", async () => {
    const org = unwrap(
      Organization.create({
        name: "Acme Inc",
        slug: "acme",
        ownerId: OWNER_ID,
      }),
    );
    await orgRepo.save(org);

    const result = await getOrganization.execute({ id: org.id });

    expect(Result.isOk(result)).toBe(true);
    expect(Result.isOk(result) && result.value?.id).toBe(org.id);
  });

  it("finds organization by slug", async () => {
    const org = unwrap(
      Organization.create({
        name: "Acme Inc",
        slug: "acme",
        ownerId: OWNER_ID,
      }),
    );
    await orgRepo.save(org);

    const result = await getOrganization.execute({ slug: "acme" });

    expect(Result.isOk(result)).toBe(true);
    expect(Result.isOk(result) && result.value?.slug).toBe("acme");
  });

  it("returns undefined when organization is not found", async () => {
    const missingId: OrganizationId = asId("00000000-0000-0000-0000-000000000099");
    const result = await getOrganization.execute({ id: missingId });

    expect(Result.isOk(result)).toBe(true);
    expect(Result.isOk(result) && result.value).toBeUndefined();
  });
});
