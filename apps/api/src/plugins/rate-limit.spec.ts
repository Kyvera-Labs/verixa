import Fastify from "fastify";
import supertest from "supertest";
import { describe, expect, it } from "vitest";

import { handleApiError } from "../http/error-response.js";

import { registerRateLimit } from "./rate-limit.js";

interface ApiErrorBody {
  error: { code: string; message: string; requestId?: string };
}

describe("rateLimitPlugin", () => {
  it("enforces default global rate limit per principal", async () => {
    const app = Fastify();
    app.setErrorHandler(handleApiError);
    registerRateLimit(app, {
      defaultMax: 2,
      defaultTimeWindowMs: 10_000,
    });

    app.get("/test", () => ({ status: "ok" }));
    await app.ready();

    // First request - allowed
    const res1 = await supertest(app.server).get("/test").set("x-user-id", "user_1");
    expect(res1.status).toBe(200);
    expect(res1.headers["x-ratelimit-remaining"]).toBe("1");

    // Second request - allowed
    const res2 = await supertest(app.server).get("/test").set("x-user-id", "user_1");
    expect(res2.status).toBe(200);
    expect(res2.headers["x-ratelimit-remaining"]).toBe("0");

    // Third request - rate limited
    const res3 = await supertest(app.server).get("/test").set("x-user-id", "user_1");
    expect(res3.status).toBe(429);
    expect(res3.headers["retry-after"]).toBeDefined();
    expect((res3.body as ApiErrorBody).error.code).toBe("RATE_LIMITED");

    // Different user with same IP is not affected
    const resDifferentUser = await supertest(app.server).get("/test").set("x-user-id", "user_2");
    expect(resDifferentUser.status).toBe(200);

    await app.close();
  });

  it("allows sensitive routes to configure stricter limits", async () => {
    const app = Fastify();
    app.setErrorHandler(handleApiError);
    registerRateLimit(app, {
      defaultMax: 50,
      defaultTimeWindowMs: 60_000,
    });

    app.post(
      "/auth/sensitive",
      {
        config: {
          rateLimit: {
            max: 1,
            timeWindowMs: 60_000,
          },
        },
      },
      () => ({ status: "ok" }),
    );
    await app.ready();

    const res1 = await supertest(app.server).post("/auth/sensitive").set("x-api-key", "key_abc");
    expect(res1.status).toBe(200);

    const res2 = await supertest(app.server).post("/auth/sensitive").set("x-api-key", "key_abc");
    expect(res2.status).toBe(429);
    expect(res2.headers["retry-after"]).toBeDefined();
    expect((res2.body as ApiErrorBody).error.code).toBe("RATE_LIMITED");

    await app.close();
  });
});
