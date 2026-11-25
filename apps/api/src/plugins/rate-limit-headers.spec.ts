import type { RateLimitKey, RateLimiter, RateLimitResult } from "@verixa/shared-kernel";
import Fastify from "fastify";
import supertest from "supertest";
import { describe, expect, it } from "vitest";

import { handleApiError } from "../http/error-response.js";

import {
  applyRateLimitHeaders,
  calculateRetryAfterSeconds,
  RATE_LIMIT_HEADERS,
  registerRateLimitHeaders,
} from "./rate-limit-headers.js";

interface ApiErrorBody {
  error: { code: string; message: string; requestId?: string };
}

class TestRateLimiter implements RateLimiter {
  private count = 0;

  constructor(
    private readonly limit: number = 2,
    private readonly resetAtMs: number = Date.now() + 60_000,
  ) {}

  async check(key: RateLimitKey): Promise<RateLimitResult> {
    await Promise.resolve();
    void key;
    this.count += 1;
    const allowed = this.count <= this.limit;
    const remaining = Math.max(0, this.limit - this.count);
    return {
      allowed,
      limit: this.limit,
      remaining,
      resetAt: this.resetAtMs,
    };
  }

  async recordFailure(key: RateLimitKey): Promise<void> {
    await Promise.resolve();
    void key;
  }

  async reset(key: RateLimitKey): Promise<void> {
    await Promise.resolve();
    void key;
    this.count = 0;
  }
}

describe("calculateRetryAfterSeconds", () => {
  it("computes seconds to reset rounding up to nearest second", () => {
    const now = 1_000_000;
    const resetAt = 1_005_200; // 5.2 seconds later
    expect(calculateRetryAfterSeconds(resetAt, now)).toBe(6);
  });

  it("enforces minimum floor of 1 second when reset timestamp is in the past or immediately expiring", () => {
    const now = 1_000_000;
    expect(calculateRetryAfterSeconds(1_000_000, now)).toBe(1);
    expect(calculateRetryAfterSeconds(999_000, now)).toBe(1);
    expect(calculateRetryAfterSeconds(1_000_100, now)).toBe(1);
  });
});

describe("applyRateLimitHeaders", () => {
  it("sets X-RateLimit headers without Retry-After on allowed responses", () => {
    const headers: Record<string, string> = {};
    const mockReply = {
      header: (name: string, value: string) => {
        headers[name.toLowerCase()] = value;
      },
    };

    const result: RateLimitResult = {
      allowed: true,
      limit: 100,
      remaining: 95,
      resetAt: 1_700_000_000_000,
    };

    applyRateLimitHeaders(mockReply as never, result);

    expect(headers[RATE_LIMIT_HEADERS.LIMIT.toLowerCase()]).toBe("100");
    expect(headers[RATE_LIMIT_HEADERS.REMAINING.toLowerCase()]).toBe("95");
    expect(headers[RATE_LIMIT_HEADERS.RESET.toLowerCase()]).toBe("1700000000");
    expect(headers[RATE_LIMIT_HEADERS.RETRY_AFTER.toLowerCase()]).toBeUndefined();
  });

  it("sets Retry-After along with X-RateLimit headers on denied responses", () => {
    const headers: Record<string, string> = {};
    const mockReply = {
      header: (name: string, value: string) => {
        headers[name.toLowerCase()] = value;
      },
    };

    const fixedNow = 1_000_000;
    const fixedReset = 1_045_000; // 45 seconds later
    const result: RateLimitResult = {
      allowed: false,
      limit: 10,
      remaining: 0,
      resetAt: fixedReset,
    };

    applyRateLimitHeaders(mockReply as never, result, fixedNow);

    expect(headers[RATE_LIMIT_HEADERS.LIMIT.toLowerCase()]).toBe("10");
    expect(headers[RATE_LIMIT_HEADERS.REMAINING.toLowerCase()]).toBe("0");
    expect(headers[RATE_LIMIT_HEADERS.RESET.toLowerCase()]).toBe(
      Math.ceil(fixedReset / 1000).toString(),
    );
    expect(headers[RATE_LIMIT_HEADERS.RETRY_AFTER.toLowerCase()]).toBe("45");
  });
});

describe("registerRateLimitHeaders Fastify hook", () => {
  it("attaches rate-limit headers to allowed routes and throttles with Retry-After on 429", async () => {
    const fixedNow = 1_700_000_000_000;
    const resetAt = fixedNow + 30_000; // 30 seconds
    const limiter = new TestRateLimiter(2, resetAt);

    const app = Fastify();
    app.setErrorHandler(handleApiError);
    registerRateLimitHeaders(app, {
      rateLimiter: limiter,
      now: () => fixedNow,
    });

    app.get(
      "/rate-limited",
      {
        config: {
          rateLimit: {
            action: "login",
            identifier: (req) => {
              const u = req.headers["x-user"];
              const user = typeof u === "string" ? u : "anon";
              return `user:${user}`;
            },
          },
        },
      },
      () => ({ status: "ok" }),
    );

    app.get("/unlimited", () => ({ status: "unlimited" }));

    await app.ready();

    // First request: allowed
    const res1 = await supertest(app.server).get("/rate-limited").set("x-user", "bob");
    expect(res1.status).toBe(200);
    expect(res1.headers["x-ratelimit-limit"]).toBe("2");
    expect(res1.headers["x-ratelimit-remaining"]).toBe("1");
    expect(res1.headers["x-ratelimit-reset"]).toBe(Math.ceil(resetAt / 1000).toString());
    expect(res1.headers["retry-after"]).toBeUndefined();

    // Second request: allowed (last available token)
    const res2 = await supertest(app.server).get("/rate-limited").set("x-user", "bob");
    expect(res2.status).toBe(200);
    expect(res2.headers["x-ratelimit-limit"]).toBe("2");
    expect(res2.headers["x-ratelimit-remaining"]).toBe("0");
    expect(res2.headers["x-ratelimit-reset"]).toBe(Math.ceil(resetAt / 1000).toString());
    expect(res2.headers["retry-after"]).toBeUndefined();

    // Third request: denied with 429 and Retry-After header
    const res3 = await supertest(app.server).get("/rate-limited").set("x-user", "bob");
    expect(res3.status).toBe(429);
    expect(res3.headers["x-ratelimit-limit"]).toBe("2");
    expect(res3.headers["x-ratelimit-remaining"]).toBe("0");
    expect(res3.headers["x-ratelimit-reset"]).toBe(Math.ceil(resetAt / 1000).toString());
    expect(res3.headers["retry-after"]).toBe("30");
    expect((res3.body as ApiErrorBody).error.code).toBe("RATE_LIMITED");

    // Unconfigured route does not have rate-limit headers
    const resUnlimited = await supertest(app.server).get("/unlimited");
    expect(resUnlimited.status).toBe(200);
    expect(resUnlimited.headers["x-ratelimit-limit"]).toBeUndefined();

    await app.close();
  });

  it("supports reply.setRateLimitHeaders decorator in custom route handlers", async () => {
    const fixedNow = 1_700_000_000_000;
    const resetAt = fixedNow + 15_000;

    const app = Fastify();
    app.setErrorHandler(handleApiError);
    registerRateLimitHeaders(app, { now: () => fixedNow });

    app.post("/custom-limited", (req, reply) => {
      reply.setRateLimitHeaders({
        allowed: true,
        limit: 50,
        remaining: 49,
        resetAt,
      });
      return { handled: true };
    });

    await app.ready();

    const res = await supertest(app.server).post("/custom-limited");
    expect(res.status).toBe(200);
    expect(res.headers["x-ratelimit-limit"]).toBe("50");
    expect(res.headers["x-ratelimit-remaining"]).toBe("49");
    expect(res.headers["x-ratelimit-reset"]).toBe(Math.ceil(resetAt / 1000).toString());

    await app.close();
  });
});
