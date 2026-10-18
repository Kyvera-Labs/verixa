import { asId, Result } from "@verixa/shared-kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { Organization } from "../../domain/entities/organization.js";
import type { UserId } from "../../domain/entities/user.js";
import { InMemoryOrganizationRepository } from "../../infrastructure/testing/in-memory-organization-repository.js";

import { ListOrganizations } from "./list-organizations.js";

const OWNER_ID: UserId = asId("00000000-0000-0000-0000-000000000001");

function unwrap<T>(result: Result<T, unknown>): T {
  if (!Result.isOk(result)) {
    throw new Error("Fixture unwrapping failed");
  }
  return result.value;
}

describe("ListOrganizations", () => {
  let orgRepo: InMemoryOrganizationRepository;
  let listOrganizations: ListOrganizations;

  beforeEach(() => {
    orgRepo = new InMemoryOrganizationRepository();
    listOrganizations = new ListOrganizations(orgRepo);
  });

  it("lists all organizations", async () => {
    const org1 = unwrap(
      Organization.create({
        name: "Org 1",
        slug: "org-1",
        ownerId: OWNER_ID,
      }),
    );
    const org2 = unwrap(
      Organization.create({
        name: "Org 2",
        slug: "org-2",
        ownerId: OWNER_ID,
      }),
    );

    await orgRepo.save(org1);
    await orgRepo.save(org2);

    const result = await listOrganizations.execute();

    expect(Result.isOk(result)).toBe(true);
    expect(Result.isOk(result) && result.value).toHaveLength(2);
  });
});
