import { ApiKey, InMemoryApiKeyRepository } from "@verixa/identity";
import { asId, Result } from "@verixa/shared-kernel";
import Fastify, { type FastifyInstance } from "fastify";
import supertest from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import { handleApiError } from "../http/error-response.js";

import { apiKeyAuth } from "./api-key-auth.js";

interface ApiErrorBody {
  error: { code: string; message: string; requestId?: string };
}

interface SecureEndpointBody {
  servicePrincipal: { type: string; name: string; organizationId: string; scopes: string[] };
  principal: { type: string };
}

describe("API Key Authentication Plugin", () => {
  let keyRepo: InMemoryApiKeyRepository;
  let app: FastifyInstance;

  beforeEach(async () => {
    keyRepo = new InMemoryApiKeyRepository();
    app = Fastify();
    app.setErrorHandler(handleApiError);

    await app.register(apiKeyAuth, {
      apiKeyRepository: keyRepo,
    });

    app.get("/v1/secure-endpoint", (req) => ({
      servicePrincipal: req.servicePrincipal,
      principal: req.principal,
    }));

    app.get("/health", () => ({ status: "ok" }));

    await app.ready();
  });

  it("permits excluded path /health without credentials", async () => {
    const res = await supertest(app.server).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("rejects request without credentials with 401 AUTHENTICATION_FAILED", async () => {
    const res = await supertest(app.server).get("/v1/secure-endpoint");
    expect(res.status).toBe(401);
    expect((res.body as ApiErrorBody).error.code).toBe("AUTHENTICATION_FAILED");
  });

  it("authenticates valid API key via Authorization: ApiKey <key>", async () => {
    const issued = ApiKey.create({
      name: "ci-service",
      organizationId: asId<"OrganizationId">("org-1"),
      scopes: ["read:audit", "write:audit"],
    });
    if (!Result.isOk(issued)) throw new Error("Failed to create key");
    await keyRepo.save(issued.value.apiKey);

    const res = await supertest(app.server)
      .get("/v1/secure-endpoint")
      .set("Authorization", `ApiKey ${issued.value.rawKey}`);

    expect(res.status).toBe(200);
    expect((res.body as SecureEndpointBody).servicePrincipal.type).toBe("service_principal");
    expect((res.body as SecureEndpointBody).servicePrincipal.name).toBe("ci-service");
    expect((res.body as SecureEndpointBody).servicePrincipal.organizationId).toBe("org-1");
    expect((res.body as SecureEndpointBody).servicePrincipal.scopes).toEqual([
      "read:audit",
      "write:audit",
    ]);
    expect((res.body as SecureEndpointBody).principal.type).toBe("service_principal");
  });

  it("authenticates valid API key via X-API-Key header", async () => {
    const issued = ApiKey.create({
      name: "backup-agent",
      organizationId: asId<"OrganizationId">("org-2"),
      scopes: ["read:all"],
    });
    if (!Result.isOk(issued)) throw new Error("Failed to create key");
    await keyRepo.save(issued.value.apiKey);

    const res = await supertest(app.server)
      .get("/v1/secure-endpoint")
      .set("X-API-Key", issued.value.rawKey);

    expect(res.status).toBe(200);
    expect((res.body as SecureEndpointBody).servicePrincipal.name).toBe("backup-agent");
  });

  it("rejects invalid API key with 401 AUTHENTICATION_FAILED", async () => {
    const res = await supertest(app.server)
      .get("/v1/secure-endpoint")
      .set("Authorization", "ApiKey vx_invalid_key_12345");

    expect(res.status).toBe(401);
    expect((res.body as ApiErrorBody).error.code).toBe("AUTHENTICATION_FAILED");
  });

  it("rejects revoked API key with 401", async () => {
    const issued = ApiKey.create({
      name: "temporary-agent",
      organizationId: asId<"OrganizationId">("org-1"),
    });
    if (!Result.isOk(issued)) throw new Error("Failed to create key");
    const revoked = issued.value.apiKey.revoke();
    await keyRepo.save(revoked);

    const res = await supertest(app.server)
      .get("/v1/secure-endpoint")
      .set("Authorization", `ApiKey ${issued.value.rawKey}`);

    expect(res.status).toBe(401);
    expect((res.body as ApiErrorBody).error.code).toBe("AUTHENTICATION_FAILED");
    expect((res.body as ApiErrorBody).error.message).toContain("revoked");
  });

  it("rejects expired API key with 401", async () => {
    const issued = ApiKey.create({
      name: "expired-agent",
      organizationId: asId<"OrganizationId">("org-1"),
      expiresAt: new Date(Date.now() + 100),
    });
    if (!Result.isOk(issued)) throw new Error("Failed to create key");
    await keyRepo.save(issued.value.apiKey);

    // Wait for key to expire
    await new Promise((resolve) => setTimeout(resolve, 150));

    const res = await supertest(app.server)
      .get("/v1/secure-endpoint")
      .set("Authorization", `ApiKey ${issued.value.rawKey}`);

    expect(res.status).toBe(401);
    expect((res.body as ApiErrorBody).error.code).toBe("AUTHENTICATION_FAILED");
    expect((res.body as ApiErrorBody).error.message).toContain("expired");
  });
});
