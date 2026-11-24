import { asId, Result } from "@verixa/shared-kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { InMemoryUnitOfWork } from "../../infrastructure/testing/in-memory-unit-of-work.js";

import { CreateOrganization } from "./create-organization.js";
import { UpdateOrganization } from "./update-organization.js";

const OWNER_ID = asId<"UserId">("00000000-0000-0000-0000-000000000001");

describe("UpdateOrganization", () => {
  let unitOfWork: InMemoryUnitOfWork;
  let updateOrganization: UpdateOrganization;

  beforeEach(async () => {
    unitOfWork = new InMemoryUnitOfWork();
    const created = await new CreateOrganization(unitOfWork).execute({
      name: "Acme Inc",
      slug: "acme",
      ownerId: OWNER_ID,
    });
    if (Result.isErr(created)) throw created.error;
    updateOrganization = new UpdateOrganization(unitOfWork.repositories.organizations);
  });

  it("updates mutable fields while preserving identity and ownership", async () => {
    const existing = await unitOfWork.repositories.organizations.findBySlug("acme");
    if (existing === undefined) throw new Error("fixture organization was not created");

    const result = await updateOrganization.execute({
      id: existing.id,
      name: "Acme Updated",
      slug: "acme-updated",
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value?.name).toBe("Acme Updated");
      expect(result.value?.slug).toBe("acme-updated");
      expect(result.value?.id).toBe(existing.id);
      expect(result.value?.ownerId).toBe(OWNER_ID);
    }
  });

  it("rejects a duplicate slug and leaves the organization unchanged", async () => {
    const second = await new CreateOrganization(unitOfWork).execute({
      name: "Other Inc",
      slug: "other",
      ownerId: asId<"UserId">("00000000-0000-0000-0000-000000000002"),
    });
    if (Result.isErr(second)) throw second.error;

    const result = await updateOrganization.execute({
      id: second.value.organization.id,
      slug: "acme",
    });

    expect(Result.isErr(result)).toBe(true);
    expect(await unitOfWork.repositories.organizations.findBySlug("other")).toBeDefined();
  });
});
