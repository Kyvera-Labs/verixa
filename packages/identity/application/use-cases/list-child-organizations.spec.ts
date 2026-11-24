import { asId, Result } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import { Organization } from "../../domain/entities/organization.js";
import { InMemoryOrganizationRepository } from "../../infrastructure/testing/in-memory-organization-repository.js";

import { ListChildOrganizations } from "./list-child-organizations.js";

const ownerId = asId<"UserId">("00000000-0000-0000-0000-000000000001");

function organization(
  name: string,
  slug: string,
  parentOrganizationId:
    import("../../domain/entities/organization.js").OrganizationId | null = null,
) {
  const result = Organization.create({ name, slug, ownerId, parentOrganizationId });
  if (Result.isErr(result)) throw new Error("fixture setup failed");
  return result.value;
}

describe("ListChildOrganizations", () => {
  it("returns only direct children", async () => {
    const repository = new InMemoryOrganizationRepository();
    const root = organization("Acme", "acme");
    const child = organization("Europe", "europe", root.id);
    const sibling = organization("Asia", "asia", root.id);
    const unrelated = organization("Other", "other");
    await Promise.all([root, child, sibling, unrelated].map((item) => repository.save(item)));

    const result = await new ListChildOrganizations(repository).execute(root.id);

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result))
      expect(result.value.map((item) => item.id)).toEqual([child.id, sibling.id]);
    const missing = await new ListChildOrganizations(repository).execute(
      asId("00000000-0000-0000-0000-000000000099"),
    );
    expect(Result.isErr(missing)).toBe(true);
    if (Result.isErr(missing)) expect(missing.error.code).toBe("NOT_FOUND");
  });
});
