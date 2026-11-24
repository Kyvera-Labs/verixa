import type { AuthorizationRepository } from "@verixa/authorization";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { buildGovernance } from "../composition-root.js";
import type { Container } from "../composition-root.js";

import { registerContextRoutes } from "./register-routes.js";

function authorizationGranting(granted: readonly string[]): AuthorizationRepository {
  return {
    hasPermission: (_user: string, _org: string | null, key: string) =>
      Promise.resolve(granted.includes(key)),
  } as unknown as AuthorizationRepository;
}

describe("registerContextRoutes governance wiring", () => {
  it("mounts the compliance case routes under /admin when governance is wired", async () => {
    const authorization = authorizationGranting([
      "compliance-cases:read",
      "compliance-cases:write",
    ]);
    const container = {
      identity: {},
      audit: {},
      authorization,
      governance: buildGovernance(authorization),
    } as unknown as Container;

    const app = Fastify();
    registerContextRoutes(app, container);
    await app.ready();

    const created = await app.inject({
      method: "POST",
      url: "/admin/organizations/org_1/compliance-cases",
      headers: { "x-user-id": "usr_1" },
      payload: { workflowType: "data-subject-request", title: "Erase my data" },
    });
    expect(created.statusCode).toBe(201);

    const listed = await app.inject({
      method: "GET",
      url: "/admin/organizations/org_1/compliance-cases",
      headers: { "x-user-id": "usr_1" },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ items: unknown[] }>().items).toHaveLength(1);

    // Approving needs a permission this user was not granted.
    const caseId = created.json<{ id: string }>().id;
    const approval = await app.inject({
      method: "POST",
      url: `/admin/organizations/org_1/compliance-cases/${caseId}/approvals`,
      headers: { "x-user-id": "usr_1" },
      payload: { role: "compliance-officer", decision: "approved" },
    });
    expect(approval.statusCode).toBe(403);
    await app.close();
  });

  it("registers no compliance routes when governance is not wired", async () => {
    const container = {
      identity: {},
      audit: {},
      authorization: {},
    } as unknown as Container;
    const app = Fastify();
    registerContextRoutes(app, container);
    await app.ready();

    const res = await app.inject({
      method: "GET",
      url: "/admin/organizations/org_1/compliance-cases",
      headers: { "x-user-id": "usr_1" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
