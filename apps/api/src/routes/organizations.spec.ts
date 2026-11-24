import {
  InMemoryOrganizationRepository,
  ListChildOrganizations,
  Organization,
} from "@verixa/identity";
import { asId, Result } from "@verixa/shared-kernel";
import { afterAll, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import type { Container } from "../composition-root.js";

describe("organization hierarchy REST API", () => {
  const repository = new InMemoryOrganizationRepository();
  const rootResult = Organization.create({
    name: "Acme",
    slug: "acme",
    ownerId: asId("00000000-0000-0000-0000-000000000001"),
  });
  if (Result.isErr(rootResult)) throw new Error("fixture setup failed");
  const childResult = Organization.create({
    name: "Europe",
    slug: "europe",
    ownerId: rootResult.value.ownerId,
    parentOrganizationId: rootResult.value.id,
  });
  if (Result.isErr(childResult)) throw new Error("fixture setup failed");
  void repository.save(rootResult.value);
  void repository.save(childResult.value);

  const container = {
    identity: { listChildOrganizations: new ListChildOrganizations(repository) },
  } as unknown as Container;
  const app = buildApp({ container });

  afterAll(async () => app.close());

  it("lists direct children and returns null for roots", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/organizations/${rootResult.value.id}/children`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({
        id: childResult.value.id,
        parentOrganizationId: rootResult.value.id,
      }),
    ]);
  });
});
