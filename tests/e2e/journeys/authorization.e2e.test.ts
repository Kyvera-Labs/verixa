import { buildContainer, type Container } from "@verixa/api/composition-root";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createTestPrismaClient,
  databaseAvailability,
} from "../../integration/helpers/database.js";
import {
  createHttpTestClient,
  type HttpTestClient,
} from "../../integration/helpers/http-client.js";
import { resetDatabase } from "../harness/reset-database.js";
import {
  grantPermissionToRole,
  seedOrganization,
  seedRole,
  seedUser,
  seedUserRoleAssignment,
} from "../harness/seed.js";

const available = await databaseAvailability();

describe.skipIf(!available)("E2E Journey: Authorization & RBAC Enforcement", () => {
  const prisma = createTestPrismaClient();
  let container: Container;
  let client: HttpTestClient;

  beforeAll(async () => {
    await prisma.$connect();
    container = buildContainer(prisma);
    client = await createHttpTestClient(container);
  }, 60_000);

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  afterEach(async () => {
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await client?.close();
    await resetDatabase(prisma);
    await prisma.$disconnect();
  }, 60_000);

  it("enforces RBAC permissions, blocks unauthorized access with zero data leakage, and reflects role changes dynamically", async () => {
    // -------------------------------------------------------------------------
    // Setup Base Hierarchy: Org, Admin, Unprivileged User, Viewer Role
    // -------------------------------------------------------------------------
    const adminUser = await seedUser(prisma, {
      email: "admin@verixa.io",
      displayName: "Global Admin",
    });
    const org = await seedOrganization(prisma, { ownerId: adminUser.id, name: "Acme Corp" });
    const unprivilegedUser = await seedUser(prisma, {
      email: "bob@verixa.io",
      displayName: "Unprivileged Bob",
    });

    // Roles and Permissions
    const adminRole = await seedRole(prisma, { name: "admin-role" });
    await grantPermissionToRole(prisma, adminRole.id, "roles:read");
    await grantPermissionToRole(prisma, adminRole.id, "roles:write");
    await seedUserRoleAssignment(prisma, {
      userId: adminUser.id,
      roleId: adminRole.id,
      organizationId: org.id,
      assignedBy: adminUser.id,
    });

    const viewerRole = await seedRole(prisma, { name: "viewer-role" });
    await grantPermissionToRole(prisma, viewerRole.id, "roles:read");

    // -------------------------------------------------------------------------
    // 1. Denied-Access Case: Unprivileged user without roles:read
    // -------------------------------------------------------------------------
    const deniedRes = await client.request
      .get("/admin/roles")
      .set("x-user-id", unprivilegedUser.id)
      .set("x-organization-id", org.id);

    // Must return 403 Forbidden
    expect(deniedRes.status).toBe(403);
    // Crucial security invariant: response MUST NOT leak any sensitive data or entity details
    expect(deniedRes.body).toEqual({ error: "Forbidden" });
    const rawDeniedOutput = JSON.stringify(deniedRes.body);
    expect(rawDeniedOutput).not.toContain("admin-role");
    expect(rawDeniedOutput).not.toContain("viewer-role");
    expect(rawDeniedOutput).not.toContain("roles:read");

    // -------------------------------------------------------------------------
    // 2. Allowed-Access Case: Admin with roles:read
    // -------------------------------------------------------------------------
    const allowedRes = await client.request
      .get("/admin/roles")
      .set("x-user-id", adminUser.id)
      .set("x-organization-id", org.id);

    expect(allowedRes.status).toBe(200);
    expect(Array.isArray(allowedRes.body)).toBe(true);
    const roleNames = (allowedRes.body as Array<{ name: string }>).map((r) => r.name);
    expect(roleNames).toContain("admin-role");
    expect(roleNames).toContain("viewer-role");

    // -------------------------------------------------------------------------
    // 3. Role-Change-Takes-Effect Case: Assign role -> Allowed, Revoke -> Denied
    // -------------------------------------------------------------------------
    // Step A: Initially Bob is denied
    const beforeAssignment = await client.request
      .get("/admin/roles")
      .set("x-user-id", unprivilegedUser.id)
      .set("x-organization-id", org.id);
    expect(beforeAssignment.status).toBe(403);

    // Step B: Admin assigns Viewer Role to Bob via HTTP endpoint
    const assignRes = await client.request
      .post(`/admin/users/${unprivilegedUser.id}/roles`)
      .set("x-user-id", adminUser.id)
      .set("x-organization-id", org.id)
      .send({
        roleId: viewerRole.id,
        organizationId: org.id,
      });

    expect(assignRes.status).toBe(201);
    const assignmentId = (assignRes.body as { id: string }).id;
    expect(assignmentId).toBeDefined();

    // Step C: Bob now immediately has access (200 OK)
    const afterAssignment = await client.request
      .get("/admin/roles")
      .set("x-user-id", unprivilegedUser.id)
      .set("x-organization-id", org.id);
    expect(afterAssignment.status).toBe(200);
    expect(Array.isArray(afterAssignment.body)).toBe(true);

    // Step D: Admin revokes the role assignment from Bob via HTTP endpoint
    const revokeRes = await client.request
      .delete(`/admin/user-role-assignments/${assignmentId}`)
      .set("x-user-id", adminUser.id)
      .set("x-organization-id", org.id);

    expect(revokeRes.status).toBe(204);

    // Step E: Bob is immediately denied again (403 Forbidden with zero data leaked)
    const afterRevocation = await client.request
      .get("/admin/roles")
      .set("x-user-id", unprivilegedUser.id)
      .set("x-organization-id", org.id);
    expect(afterRevocation.status).toBe(403);
    expect(afterRevocation.body).toEqual({ error: "Forbidden" });
    expect(JSON.stringify(afterRevocation.body)).not.toContain("viewer-role");
  });
});
