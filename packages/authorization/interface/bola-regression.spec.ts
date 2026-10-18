import Fastify from "fastify";
import supertest from "supertest";
import { describe, expect, it } from "vitest";

import type { AuthorizationRepository } from "../application/authorization-repository.js";
import type { RoleRecord } from "../domain/authorization.js";

import { registerAdminAuthorizationRoutes } from "./admin-roles.routes.js";

function createMockAuthorizationRepository(): AuthorizationRepository {
  const roles = new Map<string, RoleRecord>();
  roles.set("role_alpha", {
    id: "role_alpha",
    name: "alpha-admin",
    description: "Alpha org admin",
    isSystemRole: false,
    permissions: ["roles:read", "roles:write"],
  });
  roles.set("role_beta", {
    id: "role_beta",
    name: "beta-admin",
    description: "Beta org admin",
    isSystemRole: false,
    permissions: ["roles:read", "roles:write"],
  });

  return {
    hasPermission: (userId: string, orgId: string | null) =>
      // User belongs to org_alpha or org_beta respectively.
      Promise.resolve(
        (userId === "usr_alpha" && (orgId === "org_alpha" || orgId === null)) ||
          (userId === "usr_beta" && (orgId === "org_beta" || orgId === null)),
      ),
    // Roles are global in this RBAC model; organisation scoping lives on
    // assignments, which is what the routes under test check.
    listRoles: () => Promise.resolve(Array.from(roles.values())),
    createRole: (input) => {
      const record: RoleRecord = {
        id: `role_${Date.now()}`,
        name: input.name,
        description: input.description,
        isSystemRole: input.isSystemRole,
        permissions: [],
      };
      roles.set(record.id, record);
      return Promise.resolve(record);
    },
    getRole: (roleId: string) => Promise.resolve(roles.get(roleId)),
    updateRole: (roleId: string, input) => {
      const existing = roles.get(roleId);
      if (!existing) return Promise.reject(new Error("Role not found"));
      const updated = { ...existing, ...input };
      roles.set(roleId, updated);
      return Promise.resolve(updated);
    },
    deleteRole: (roleId: string) => {
      roles.delete(roleId);
      return Promise.resolve();
    },
    listPermissions: () => Promise.resolve([]),
    grantPermission: () => Promise.reject(new Error("Not implemented in mock")),
    revokePermission: () => Promise.reject(new Error("Not implemented in mock")),
    listAssignments: (userId: string, orgId?: string) =>
      Promise.resolve([
        {
          id: `asgn_${userId}`,
          userId,
          roleId: "role_alpha",
          organizationId: orgId ?? "org_alpha",
          assignedBy: "admin",
          assignedAt: new Date(),
          expiresAt: null,
          role: roles.get("role_alpha")!,
        },
      ]),
    assignRole: (input) =>
      Promise.resolve({
        id: "asgn_new",
        userId: input.userId,
        roleId: input.roleId,
        organizationId: input.organizationId,
        assignedBy: input.assignedBy,
        assignedAt: new Date(),
        expiresAt: input.expiresAt,
        role: roles.get(input.roleId)!,
      }),
    revokeAssignment: () => Promise.resolve(),
  };
}

describe("BOLA regression test across admin authorization routes", () => {
  function buildTestServer() {
    const app = Fastify();
    const repo = createMockAuthorizationRepository();
    // Mounted at /admin prefix as done in composition root
    app.register(
      (scope) => {
        registerAdminAuthorizationRoutes(scope, repo);
      },
      { prefix: "/admin" },
    );
    return app;
  }

  it("Route 1 (GET /admin/users/:userId/roles): rejects accessing roles of another organization", async () => {
    const app = buildTestServer();
    await app.ready();

    // Caller is in org_alpha, trying to access query with org_beta
    const response = await supertest(app.server)
      .get("/admin/users/usr_alpha/roles?organizationId=org_beta")
      .set("x-user-id", "usr_alpha")
      .set("x-organization-id", "org_alpha");

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Forbidden" });

    await app.close();
  });

  it("Route 2 (POST /admin/users/:userId/roles): rejects assigning a role scoped to another organization", async () => {
    const app = buildTestServer();
    await app.ready();

    // Caller in org_alpha attempts to assign role under org_beta
    const response = await supertest(app.server)
      .post("/admin/users/usr_target/roles")
      .set("x-user-id", "usr_alpha")
      .set("x-organization-id", "org_alpha")
      .send({
        roleId: "role_alpha",
        organizationId: "org_beta",
      });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Forbidden" });

    await app.close();
  });

  it("Route 3 (GET /admin/roles): forbids caller lacking permissions from accessing other organization resources", async () => {
    const app = buildTestServer();
    await app.ready();

    // Caller usr_alpha attempting to list roles claiming org_beta header without org_beta membership
    const response = await supertest(app.server)
      .get("/admin/roles")
      .set("x-user-id", "usr_alpha")
      .set("x-organization-id", "org_beta");

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Forbidden" });

    await app.close();
  });
});
