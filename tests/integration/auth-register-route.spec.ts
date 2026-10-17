import { buildContainer, type Container } from "@verixa/api/composition-root";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createTestPrismaClient, databaseAvailability } from "./helpers/database.js";
import { createHttpTestClient, type HttpTestClient } from "./helpers/http-client.js";

/**
 * The first genuinely end-to-end test: real HTTP → route → use case →
 * repository → Postgres.
 *
 * Everything below has been tested in isolation for months — the domain
 * against no infrastructure, use cases against fakes, adapters against
 * contract suites. None of that proves the pieces *compose*. A container that
 * wires the wrong repository, a route that never reaches its use case, a
 * Prisma client that works in a test harness and not under Fastify: all of
 * those typecheck perfectly and all of them are caught here and nowhere else.
 */

const available = await databaseAvailability();

/**
 * Supertest types `response.body` as `any`, which defeats the type-aware lint
 * rules and — more to the point — means a typo in an assertion path silently
 * passes instead of failing. Naming the shapes here restores both.
 */
interface RegisteredUserBody {
  id: string;
  email: string;
  displayName: string;
  status: string;
  createdAt: string;
}

interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: { fields?: Record<string, string[]> };
    requestId: string;
  };
}

const asUser = (body: unknown): RegisteredUserBody => body as RegisteredUserBody;
const asError = (body: unknown): ApiErrorBody => body as ApiErrorBody;

describe.skipIf(!available)("POST /auth/register", () => {
  const prisma = createTestPrismaClient();
  let container: Container;
  let client: HttpTestClient;

  beforeAll(async () => {
    // A container pointed at the test database rather than one built from
    // DATABASE_URL — a suite that writes users must not be one environment
    // variable away from a developer's own database.
    container = buildContainer(prisma);
    client = await createHttpTestClient(container);
  }, 60_000);

  afterEach(async () => {
    await prisma.credential.deleteMany({});
    await prisma.invitation.deleteMany({});
    await prisma.organizationMembership.deleteMany({});
    await prisma.organization.deleteMany({});
    await prisma.user.deleteMany({});
  });

  afterAll(async () => {
    await client.close();
    await prisma.$disconnect();
  }, 60_000);

  const VALID = {
    email: "alice@example.com",
    displayName: "Alice",
    password: "correct horse battery staple",
  };

  it("creates a user and credential, returning 201", async () => {
    const response = await client.request.post("/auth/register").send(VALID);

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      email: "alice@example.com",
      displayName: "Alice",
      status: "pending",
    });
    expect(asUser(response.body).id).toBeTruthy();

    await expect(prisma.user.count()).resolves.toBe(1);
    await expect(prisma.credential.count()).resolves.toBe(1);
  });

  it("never returns the password or its hash", async () => {
    const response = await client.request.post("/auth/register").send(VALID);

    // The response object deliberately omits the credential entirely, rather
    // than relying on Credential.toJSON redacting it. Two independent
    // defences, because a refactor could remove either one.
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain(VALID.password);
    expect(serialized).not.toContain("argon2");
    expect(serialized).not.toContain("passwordHash");
  });

  it("stores a real argon2 hash, not the plaintext", async () => {
    await client.request.post("/auth/register").send(VALID);

    const credential = await prisma.credential.findFirst();
    expect(credential?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(credential?.passwordHash).not.toContain(VALID.password);
  });

  it("rejects a weak password with 400 and names the field", async () => {
    const response = await client.request.post("/auth/register").send({ ...VALID, password: "x" });

    expect(response.status).toBe(400);
    expect(asError(response.body).error.code).toBe("VALIDATION_ERROR");
    expect(asError(response.body).error.details?.fields?.["password"]).toContain("too_short");
    await expect(prisma.user.count()).resolves.toBe(0);
  });

  it("rejects an invalid email with 400", async () => {
    const response = await client.request
      .post("/auth/register")
      .send({ ...VALID, email: "not-an-email" });

    expect(response.status).toBe(400);
    expect(asError(response.body).error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a missing field with 400 before reaching the domain", async () => {
    // Caught by the JSON schema, not the use case. The schema's job is shape;
    // the domain's job is rules.
    const response = await client.request
      .post("/auth/register")
      .send({ email: "alice@example.com" });

    expect(response.status).toBe(400);
  });

  it("rejects unknown properties rather than silently ignoring them", async () => {
    // `additionalProperties: false`. Silently accepting an unexpected field is
    // how a client ends up believing it set something it did not — e.g.
    // posting `status: "active"` and assuming it took effect.
    const response = await client.request
      .post("/auth/register")
      .send({ ...VALID, status: "active" });

    expect(response.status).toBe(400);
  });

  it("returns 409 for a duplicate email", async () => {
    await client.request.post("/auth/register").send(VALID);

    const response = await client.request.post("/auth/register").send(VALID);

    expect(response.status).toBe(409);
    expect(asError(response.body).error.code).toBe("CONFLICT");
    await expect(prisma.user.count()).resolves.toBe(1);
  });

  it("treats a case-differing email as a duplicate", async () => {
    await client.request.post("/auth/register").send(VALID);

    const response = await client.request
      .post("/auth/register")
      .send({ ...VALID, email: "ALICE@EXAMPLE.COM" });

    expect(response.status).toBe(409);
  });

  it("leaves nothing behind when registration fails", async () => {
    await client.request.post("/auth/register").send({ ...VALID, password: "x" });

    await expect(prisma.user.count()).resolves.toBe(0);
    await expect(prisma.credential.count()).resolves.toBe(0);
  });
});

describe("GET /health without a container", () => {
  it("still responds, since liveness must not depend on the database", async () => {
    const client = await createHttpTestClient();
    try {
      const response = await client.request.get("/health");
      expect(response.status).toBe(200);
    } finally {
      await client.close();
    }
  });

  it("returns 404 for auth routes rather than a 500", async () => {
    const client = await createHttpTestClient();
    try {
      // "This server was not built with that capability" is true; "it is
      // broken" would not be.
      const response = await client.request.post("/auth/register").send({});
      expect(response.status).toBe(404);
    } finally {
      await client.close();
    }
  });
});
