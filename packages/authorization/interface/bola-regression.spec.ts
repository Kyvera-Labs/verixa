import Fastify from "fastify";
import supertest from "supertest";
import { describe, expect, it } from "vitest";

import type {
  AuthorizationRepository,
  RoleRecord,
} from "../../application/authorization-repository.js";
import { registerAdminAuthorizationRoutes } from "./admin-roles.routes.js";

function createMockAuthorizationRepository(): AuthorizationRepository {
  const roles = new Map<string, RoleRecord>();
  roles.set("role_alpha", {
    id: "role_alpha",
    name: "alpha-admin",
    description: "Alpha org admin",
    organizationId: "org_alpha",
    isSystemRole: false,
    permissions: ["roles:read", "roles:write"],
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  roles.set("role_beta", {
    id: "role_beta",
    name: "beta-admin",
    description: "Beta org admin",
    organizationId: "org_beta",
    isSystemRole: false,
    permissions: ["roles:read", "roles:write"],
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return {
    hasPermission: async (userId: string, orgId: string | null, _permission: string) => {
      // User belongs to org_alpha
      if (userId === "usr_alpha" && (orgId === "org_alpha" || orgId === null)) return true;
      if (userId === "usr_beta" && (orgId === "org_beta" || orgId === null)) return true;
      return false;
    },
    listRoles: async (orgId?: string) => {
      return Array.from(roles.values()).filter(
        (r) => orgId === undefined || r.organizationId === orgId,
      );
    },
    createRole: async (input) => {
      const record: RoleRecord = {
        id: `role_${Date.now()}`,
        name: input.name,
        description: input.description,
        organizationId: input.organizationId ?? null,
        isSystemRole: input.isSystemRole,
        permissions: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      roles.set(record.id, record);
      return record;
    },
    getRole: async (roleId: string) => roles.get(roleId),
    updateRole: async (roleId: string, input) => {
      const existing = roles.get(roleId);
      if (!existing) throw new Error("Role not found");
      const updated = { ...existing, ...input, updatedAt: new Date() };
      roles.set(roleId, updated);
      return updated;
    },
    deleteRole: async (roleId: string) => {
      roles.delete(roleId);
    },
    listPermissions: async () => [],
    grantPermission: async (_roleId, _key) => {
      throw new Error("Not implemented in mock");
    },
    revokePermission: async (_roleId, _key) => {
      throw new Error("Not implemented in mock");
    },
    listAssignments: async (userId: string, orgId?: string) => {
      return [
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
      ];
    },
    assignRole: async (input) => {
      return {
        id: "asgn_new",
        userId: input.userId,
        roleId: input.roleId,
        organizationId: input.organizationId,
        assignedBy: input.assignedBy,
        assignedAt: new Date(),
        expiresAt: input.expiresAt,
        role: roles.get(input.roleId)!,
      };
    },
    revokeAssignment: async (_assignmentId: string) => {},
  };
}

describe("BOLA regression test across admin authorization routes", () => {
  function buildTestServer() {
    const app = Fastify();
    const repo = createMockAuthorizationRepository();
    // Mounted at /admin prefix as done in composition root
    app.register(
      async (scope) => {
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
