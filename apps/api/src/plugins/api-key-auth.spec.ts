import { ApiKey, InMemoryApiKeyRepository } from "@verixa/identity";
import { Result } from "@verixa/shared-kernel";
import Fastify from "fastify";
import supertest from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import { handleApiError } from "../http/error-response.js";
import { apiKeyAuth } from "./api-key-auth.js";

describe("API Key Authentication Plugin", () => {
  let keyRepo: InMemoryApiKeyRepository;
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    keyRepo = new InMemoryApiKeyRepository();
    app = Fastify();
    app.setErrorHandler(handleApiError);

    await app.register(apiKeyAuth, {
      apiKeyRepository: keyRepo,
    });

    app.get("/v1/secure-endpoint", async (req, reply) => {
      return {
        servicePrincipal: req.servicePrincipal,
        principal: req.principal,
      };
    });

    app.get("/health", async () => ({ status: "ok" }));

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
    expect(res.body.error.code).toBe("AUTHENTICATION_FAILED");
  });

  it("authenticates valid API key via Authorization: ApiKey <key>", async () => {
    const issued = ApiKey.create({
      name: "ci-service",
      organizationId: "org-1" as any,
      scopes: ["read:audit", "write:audit"],
    });
    if (!Result.isOk(issued)) throw new Error("Failed to create key");
    await keyRepo.save(issued.value.apiKey);

    const res = await supertest(app.server)
      .get("/v1/secure-endpoint")
      .set("Authorization", `ApiKey ${issued.value.rawKey}`);

    expect(res.status).toBe(200);
    expect(res.body.servicePrincipal.type).toBe("service_principal");
    expect(res.body.servicePrincipal.name).toBe("ci-service");
    expect(res.body.servicePrincipal.organizationId).toBe("org-1");
    expect(res.body.servicePrincipal.scopes).toEqual(["read:audit", "write:audit"]);
    expect(res.body.principal.type).toBe("service_principal");
  });

  it("authenticates valid API key via X-API-Key header", async () => {
    const issued = ApiKey.create({
      name: "backup-agent",
      organizationId: "org-2" as any,
      scopes: ["read:all"],
    });
    if (!Result.isOk(issued)) throw new Error("Failed to create key");
    await keyRepo.save(issued.value.apiKey);

    const res = await supertest(app.server)
      .get("/v1/secure-endpoint")
      .set("X-API-Key", issued.value.rawKey);

    expect(res.status).toBe(200);
    expect(res.body.servicePrincipal.name).toBe("backup-agent");
  });

  it("rejects invalid API key with 401 AUTHENTICATION_FAILED", async () => {
    const res = await supertest(app.server)
      .get("/v1/secure-endpoint")
      .set("Authorization", "ApiKey vx_invalid_key_12345");

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTHENTICATION_FAILED");
  });

  it("rejects revoked API key with 401", async () => {
    const issued = ApiKey.create({
      name: "temporary-agent",
      organizationId: "org-1" as any,
    });
    if (!Result.isOk(issued)) throw new Error("Failed to create key");
    const revoked = issued.value.apiKey.revoke();
    await keyRepo.save(revoked);

    const res = await supertest(app.server)
      .get("/v1/secure-endpoint")
      .set("Authorization", `ApiKey ${issued.value.rawKey}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTHENTICATION_FAILED");
    expect(res.body.error.message).toContain("revoked");
  });

  it("rejects expired API key with 401", async () => {
    const issued = ApiKey.create({
      name: "expired-agent",
      organizationId: "org-1" as any,
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
    expect(res.body.error.code).toBe("AUTHENTICATION_FAILED");
    expect(res.body.error.message).toContain("expired");
  });
});
