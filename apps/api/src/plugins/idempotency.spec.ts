import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { errorResponseSchema, handleApiError } from "../http/error-response.js";

import { registerIdempotency } from "./idempotency.js";

describe("idempotency plugin", () => {
  it("returns original response on identical request with same key and only executes handler once", async () => {
    let sideEffects = 0;
    const app = Fastify();
    app.setErrorHandler(handleApiError);
    app.addSchema(errorResponseSchema);

    // Register idempotency with a 10s TTL
    registerIdempotency(app, { ttlSeconds: 10 });

    app.post("/test-create", async (req, reply) => {
      sideEffects += 1;
      return reply.status(201).send({
        id: "res_123",
        created: true,
        body: req.body,
      });
    });

    await app.ready();

    // First request
    const res1 = await app.inject({
      method: "POST",
      url: "/test-create",
      headers: {
        "idempotency-key": "idem-key-1",
        "content-type": "application/json",
      },
      payload: { name: "Resource A" },
    });

    expect(res1.statusCode).toBe(201);
    expect(res1.json()).toEqual({ id: "res_123", created: true, body: { name: "Resource A" } });
    expect(sideEffects).toBe(1);

    // Second request with identical key and payload
    const res2 = await app.inject({
      method: "POST",
      url: "/test-create",
      headers: {
        "idempotency-key": "idem-key-1",
        "content-type": "application/json",
      },
      payload: { name: "Resource A" },
    });

    expect(res2.statusCode).toBe(201);
    expect(res2.headers["idempotency-replayed"]).toBe("true");
    expect(res2.json()).toEqual({ id: "res_123", created: true, body: { name: "Resource A" } });
    // Side effects should NOT increase
    expect(sideEffects).toBe(1);

    await app.close();
  });

  it("rejects different body with same key as 409 CONFLICT", async () => {
    let sideEffects = 0;
    const app = Fastify();
    app.setErrorHandler(handleApiError);
    app.addSchema(errorResponseSchema);

    registerIdempotency(app, { ttlSeconds: 10 });

    app.post("/test-conflict", async (req, reply) => {
      sideEffects += 1;
      return reply.status(201).send({ result: "ok" });
    });

    await app.ready();

    // First request
    const res1 = await app.inject({
      method: "POST",
      url: "/test-conflict",
      headers: {
        "idempotency-key": "idem-conflict-key",
        "content-type": "application/json",
      },
      payload: { value: 1 },
    });

    expect(res1.statusCode).toBe(201);
    expect(sideEffects).toBe(1);

    // Reused key with different payload
    const res2 = await app.inject({
      method: "POST",
      url: "/test-conflict",
      headers: {
        "idempotency-key": "idem-conflict-key",
        "content-type": "application/json",
      },
      payload: { value: 2 },
    });

    expect(res2.statusCode).toBe(409);
    const body = res2.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("CONFLICT");
    expect(sideEffects).toBe(1);

    await app.close();
  });

  it("expires idempotency keys after TTL", async () => {
    let sideEffects = 0;
    const app = Fastify();
    app.setErrorHandler(handleApiError);
    app.addSchema(errorResponseSchema);

    // 0 or short TTL
    registerIdempotency(app, { ttlSeconds: 1 });

    app.post("/test-ttl", async (req, reply) => {
      sideEffects += 1;
      return reply.status(201).send({ run: sideEffects });
    });

    await app.ready();

    const res1 = await app.inject({
      method: "POST",
      url: "/test-ttl",
      headers: {
        "idempotency-key": "idem-ttl-key",
        "content-type": "application/json",
      },
      payload: { item: true },
    });

    expect(res1.statusCode).toBe(201);
    expect(sideEffects).toBe(1);

    // Wait for TTL (1.1s)
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Request after TTL should execute handler again
    const res2 = await app.inject({
      method: "POST",
      url: "/test-ttl",
      headers: {
        "idempotency-key": "idem-ttl-key",
        "content-type": "application/json",
      },
      payload: { item: true },
    });

    expect(res2.statusCode).toBe(201);
    expect(res2.headers["idempotency-replayed"]).toBeUndefined();
    expect(sideEffects).toBe(2);

    await app.close();
  });
});
