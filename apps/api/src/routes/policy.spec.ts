import Fastify, { type FastifyInstance } from "fastify";
import supertest from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import { handleApiError } from "../http/error-response.js";

import {
  registerPolicyRoutes,
  type PolicyDto,
  type PolicyManagementUseCases,
  type PolicyPage,
  type PolicyRouteDependencies,
  type PolicyVersionDto,
} from "./policy.js";

const draft: PolicyDto = {
  id: "pol_1",
  organizationId: "org_a",
  name: "MFA policy",
  ruleset: { requireMfa: true },
  status: "draft",
  version: 0,
};

const published: PolicyDto = { ...draft, status: "published", version: 1 };

class FakePolicies implements PolicyManagementUseCases {
  public lastPublish: { organizationId: string; policyId: string } | undefined;
  public readonly versionsPage: PolicyPage<PolicyVersionDto> = {
    items: [{ version: 1, ruleset: { requireMfa: true }, publishedAt: "2026-11-22T00:00:00.000Z" }],
    hasMore: true,
    nextCursor: "v1",
  };

  async create(input: {
    organizationId: string;
    name: string;
    ruleset: Readonly<Record<string, unknown>>;
  }) {
    return {
      ...draft,
      organizationId: input.organizationId,
      name: input.name,
      ruleset: input.ruleset,
    };
  }

  async list(): Promise<PolicyPage<PolicyDto>> {
    return { items: [draft], hasMore: false, nextCursor: null };
  }

  async update(): Promise<PolicyDto> {
    return draft;
  }

  async publish(input: { organizationId: string; policyId: string }): Promise<PolicyDto> {
    this.lastPublish = input;
    return published;
  }

  async versions(): Promise<PolicyPage<PolicyVersionDto>> {
    return this.versionsPage;
  }
}

function makeApp(fake = new FakePolicies()): { app: FastifyInstance; fake: FakePolicies } {
  const dependencies: PolicyRouteDependencies = {
    policies: fake,
    authorization: { hasPermission: async () => true },
  };
  const app = Fastify({ logger: false });
  app.setErrorHandler(handleApiError);
  app.register((scope) => registerPolicyRoutes(scope, dependencies), { prefix: "/admin" });
  return { app, fake };
}

const ownHeaders = {
  "x-user-id": "user_a",
  "x-organization-id": "org_a",
};

describe("Policy management routes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = makeApp().app;
    await app.ready();
  });

  it("creates and lists policies through the injected use cases", async () => {
    const created = await supertest(app.server)
      .post("/admin/organizations/org_a/policies")
      .set(ownHeaders)
      .send({ name: "MFA policy", ruleset: { requireMfa: true } });
    expect(created.status).toBe(201);
    expect(created.body.organizationId).toBe("org_a");

    const listed = await supertest(app.server)
      .get("/admin/organizations/org_a/policies?limit=10")
      .set(ownHeaders);
    expect(listed.status).toBe(200);
    expect(listed.body.items).toHaveLength(1);
  });

  it("rejects malformed policy bodies before invoking the use case", async () => {
    const response = await supertest(app.server)
      .post("/admin/organizations/org_a/policies")
      .set(ownHeaders)
      .send({ name: "", ruleset: [] });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("does not leak another organization's policy existence", async () => {
    const response = await supertest(app.server)
      .post("/admin/organizations/org_b/policies")
      .set(ownHeaders)
      .send({ name: "Should not be visible", ruleset: {} });
    expect(response.status).toBe(404);
    expect(response.body.error.message).toBe("Policy not found.");
  });

  it("publishes through an idempotent application operation", async () => {
    const { app: publishApp, fake } = makeApp();
    await publishApp.ready();
    const response = await supertest(publishApp.server)
      .post("/admin/organizations/org_a/policies/pol_1/publish")
      .set(ownHeaders);
    expect(response.status).toBe(200);
    expect(response.body.version).toBe(1);
    expect(fake.lastPublish).toEqual({ organizationId: "org_a", policyId: "pol_1" });
  });

  it("returns paginated immutable versions", async () => {
    const response = await supertest(app.server)
      .get("/admin/organizations/org_a/policies/pol_1/versions?limit=1")
      .set(ownHeaders);
    expect(response.status).toBe(200);
    expect(response.body.items[0].version).toBe(1);
    expect(response.body.hasMore).toBe(true);
    expect(response.body.nextCursor).toBe("v1");
  });
});
