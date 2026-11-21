import supertest from "supertest";
import { afterAll, describe, expect, it } from "vitest";

import { buildApp } from "../../app.js";
import { registerRateLimit } from "../../plugins/rate-limit.js";

describe("GET /health/live", () => {
  const app = buildApp();

  afterAll(async () => {
    await app.close();
  });

  it("responds with 200 and status ok without any backing dependencies or auth", async () => {
    await app.ready();

    const start = performance.now();
    const response = await supertest(app.server).get("/health/live");
    const elapsedMs = performance.now() - start;

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
    // Typical Kubernetes liveness probe timeouts are 1000ms+; a pure event-loop
    // check should complete well under 500ms even in a busy test runner.
    expect(elapsedMs).toBeLessThan(500);
  });

  it("remains responsive under concurrent probe load", async () => {
    await app.ready();

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => app.inject({ method: "GET", url: "/health/live" })),
    );

    for (const res of responses) {
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "ok" });
    }
  });
});

describe("GET /health/live rate-limit exclusion", () => {
  const app = buildApp();
  registerRateLimit(app, { defaultMax: 1, defaultTimeWindowMs: 60_000 });

  afterAll(async () => {
    await app.close();
  });

  it("is never throttled when rate limiting is enabled", async () => {
    await app.ready();

    for (let i = 0; i < 5; i += 1) {
      const res = await app.inject({ method: "GET", url: "/health/live" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "ok" });
      expect(res.headers["x-ratelimit-limit"]).toBeUndefined();
    }
  });
});
