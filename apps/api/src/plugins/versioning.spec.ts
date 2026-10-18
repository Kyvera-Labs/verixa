import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { handleApiError } from "../http/error-response.js";
import { versioning } from "./versioning.js";

describe("API Versioning plugin", () => {
  it("allows requests matching supported version /v1", async () => {
    const app = Fastify();
    app.setErrorHandler(handleApiError);
    await app.register(versioning);

    app.get("/v1/items", async () => ({ items: [] }));
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/v1/items" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [] });
    await app.close();
  });

  it("rejects unversioned requests with a clear 400 error", async () => {
    const app = Fastify();
    app.setErrorHandler(handleApiError);
    await app.register(versioning);

    app.get("/items", async () => ({ items: [] }));
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/items" });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toContain("API version prefix missing");
    await app.close();
  });

  it("rejects requests for unsupported versions with a 404 error", async () => {
    const app = Fastify();
    app.setErrorHandler(handleApiError);
    await app.register(versioning);

    app.get("/v2/items", async () => ({ items: [] }));
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/v2/items" });
    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toContain("API version 'v2' is not supported");
    await app.close();
  });

  it("permits excluded paths such as /health and /docs unversioned", async () => {
    const app = Fastify();
    app.setErrorHandler(handleApiError);
    await app.register(versioning);

    app.get("/health", async () => ({ status: "ok" }));
    app.get("/docs/openapi.json", async () => ({ openapi: "3.0.0" }));
    await app.ready();

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok" });

    const docs = await app.inject({ method: "GET", url: "/docs/openapi.json" });
    expect(docs.statusCode).toBe(200);
    expect(docs.json()).toEqual({ openapi: "3.0.0" });
    await app.close();
  });

  it("emits Deprecation and Sunset headers on deprecated routes", async () => {
    const app = Fastify();
    app.setErrorHandler(handleApiError);
    await app.register(versioning);

    const sunsetDate = "2027-01-01T00:00:00.000Z";
    app.get(
      "/v1/legacy",
      {
        config: {
          deprecated: true,
          sunset: sunsetDate,
        },
      },
      async () => ({ legacy: true }),
    );

    app.get("/v1/current", async () => ({ current: true }));
    await app.ready();

    const deprecatedRes = await app.inject({ method: "GET", url: "/v1/legacy" });
    expect(deprecatedRes.statusCode).toBe(200);
    expect(deprecatedRes.headers["deprecation"]).toBe("true");
    expect(deprecatedRes.headers["sunset"]).toBe(new Date(sunsetDate).toUTCString());

    const currentRes = await app.inject({ method: "GET", url: "/v1/current" });
    expect(currentRes.statusCode).toBe(200);
    expect(currentRes.headers["deprecation"]).toBeUndefined();
    expect(currentRes.headers["sunset"]).toBeUndefined();

    await app.close();
  });
});
