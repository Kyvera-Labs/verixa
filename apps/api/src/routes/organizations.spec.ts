import { asId, Result } from "@verixa/shared-kernel";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../app.js";
import type { Container } from "../composition-root.js";

const organization = {
  id: asId("00000000-0000-0000-0000-000000000010"),
  name: "Acme Inc",
  slug: "acme",
  ownerId: asId("00000000-0000-0000-0000-000000000011"),
  status: "active" as const,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

type OrganizationResponse = { id: string; slug: string };
type ErrorResponse = { error: { code: string } };

function makeContainer() {
  const hasPermission = vi.fn().mockResolvedValue(true);
  const container = {
    authorization: { hasPermission },
    identity: {
      createOrganization: { execute: vi.fn().mockResolvedValue(Result.ok({ organization })) },
      getOrganization: { execute: vi.fn().mockResolvedValue(Result.ok(organization)) },
      listOrganizations: { execute: vi.fn().mockResolvedValue(Result.ok([organization])) },
      updateOrganization: { execute: vi.fn().mockResolvedValue(Result.ok(organization)) },
    },
    audit: {},
  } as unknown as Container;
  return { container, hasPermission };
}

describe("admin organization routes", () => {
  const { container, hasPermission } = makeContainer();
  const app = buildApp({ container });

  beforeAll(async () => app.ready());
  afterAll(async () => app.close());

  it("creates an organization and returns the resource", async () => {
    const response = await supertest(app.server)
      .post("/admin/organizations")
      .set("x-user-id", "platform-admin")
      .send({ name: "Acme Inc", slug: "acme", ownerId: organization.ownerId });

    expect(response.status).toBe(201);
    expect(response.body as OrganizationResponse).toMatchObject({
      id: organization.id,
      slug: "acme",
    });
    expect(hasPermission).toHaveBeenCalledWith("platform-admin", null, "organizations:write");
  });

  it("lists and retrieves organizations for a read-authorized admin", async () => {
    const list = await supertest(app.server)
      .get("/admin/organizations")
      .set("x-user-id", "platform-admin");
    const item = await supertest(app.server)
      .get(`/admin/organizations/${organization.id}`)
      .set("x-user-id", "platform-admin");

    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(item.status).toBe(200);
    expect((item.body as OrganizationResponse).slug).toBe("acme");
  });

  it("patches an organization and returns the updated resource", async () => {
    const response = await supertest(app.server)
      .patch(`/admin/organizations/${organization.id}`)
      .set("x-user-id", "platform-admin")
      .send({ name: "Acme Updated" });

    expect(response.status).toBe(200);
    expect((response.body as OrganizationResponse).id).toBe(organization.id);
  });

  it("rejects malformed payloads with 400", async () => {
    const response = await supertest(app.server)
      .post("/admin/organizations")
      .set("x-user-id", "platform-admin")
      .send({ name: "Acme", slug: "acme", unexpected: true });

    expect(response.status).toBe(400);
    expect((response.body as ErrorResponse).error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects callers without platform admin permission with 403", async () => {
    hasPermission.mockResolvedValue(false);

    const response = await supertest(app.server)
      .get("/admin/organizations")
      .set("x-user-id", "regular-user");

    expect(response.status).toBe(403);
    expect((response.body as ErrorResponse).error.code).toBe("FORBIDDEN");
  });

  it("rejects missing authentication with 403", async () => {
    const response = await supertest(app.server).get("/admin/organizations");

    expect(response.status).toBe(403);
  });
});
