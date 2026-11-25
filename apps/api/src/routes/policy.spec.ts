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
    await Promise.resolve();
    return {
      ...draft,
      organizationId: input.organizationId,
      name: input.name,
      ruleset: input.ruleset,
    };
  }

  async list(): Promise<PolicyPage<PolicyDto>> {
    await Promise.resolve();
    return { items: [draft], hasMore: false, nextCursor: null };
  }

  async update(): Promise<PolicyDto> {
    await Promise.resolve();
    return draft;
  }

  async publish(input: { organizationId: string; policyId: string }): Promise<PolicyDto> {
    await Promise.resolve();
    this.lastPublish = input;
    return published;
  }

  async versions(): Promise<PolicyPage<PolicyVersionDto>> {
    await Promise.resolve();
    return this.versionsPage;
  }
}

// supertest types `body` as any; read the fields these tests use through this.
interface Json {
  organizationId: string;
  version: number;
  items: Array<{ version: number }>;
  hasMore: boolean;
  nextCursor: string | null;
  error: { code: string; message: string };
}
const json = (res: { body: unknown }): Json => res.body as Json;

function makeApp(fake = new FakePolicies()): { app: FastifyInstance; fake: FakePolicies } {
  const dependencies: PolicyRouteDependencies = {
    policies: fake,
    authorization: { hasPermission: () => Promise.resolve(true) },
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
    expect(json(created).organizationId).toBe("org_a");

    const listed = await supertest(app.server)
      .get("/admin/organizations/org_a/policies?limit=10")
      .set(ownHeaders);
    expect(listed.status).toBe(200);
    expect(json(listed).items).toHaveLength(1);
  });

  it("rejects malformed policy bodies before invoking the use case", async () => {
    const response = await supertest(app.server)
      .post("/admin/organizations/org_a/policies")
      .set(ownHeaders)
      .send({ name: "", ruleset: [] });
    expect(response.status).toBe(400);
    expect(json(response).error.code).toBe("VALIDATION_ERROR");
  });

  it("does not leak another organization's policy existence", async () => {
    const response = await supertest(app.server)
      .post("/admin/organizations/org_b/policies")
      .set(ownHeaders)
      .send({ name: "Should not be visible", ruleset: {} });
    expect(response.status).toBe(404);
    expect(json(response).error.message).toBe("Policy not found.");
  });

  it("publishes through an idempotent application operation", async () => {
    const { app: publishApp, fake } = makeApp();
    await publishApp.ready();
    const response = await supertest(publishApp.server)
      .post("/admin/organizations/org_a/policies/pol_1/publish")
      .set(ownHeaders);
    expect(response.status).toBe(200);
    expect(json(response).version).toBe(1);
    expect(fake.lastPublish).toEqual({ organizationId: "org_a", policyId: "pol_1" });
  });

  it("returns paginated immutable versions", async () => {
    const response = await supertest(app.server)
      .get("/admin/organizations/org_a/policies/pol_1/versions?limit=1")
      .set(ownHeaders);
    expect(response.status).toBe(200);
    expect(json(response).items[0]?.version).toBe(1);
    expect(json(response).hasMore).toBe(true);
    expect(json(response).nextCursor).toBe("v1");
  });
});
