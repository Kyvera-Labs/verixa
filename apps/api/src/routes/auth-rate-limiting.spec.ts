import { RateLimitExceededError } from "@verixa/shared-kernel";
import Fastify, { type FastifyInstance } from "fastify";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Container } from "../composition-root.js";
import { handleApiError } from "../http/error-response.js";

import { registerAuthRoutes } from "./auth.js";

interface ApiErrorBody {
  error: { code: string; message: string; requestId?: string };
}

describe("Auth routes rate limiting retrofit (Issue 294)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.setErrorHandler(handleApiError);

    let loginAttempts = 0;
    let registerAttempts = 0;
    let forgotPasswordAttempts = 0;
    let resetPasswordAttempts = 0;
    let refreshAttempts = 0;

    const mockContainer = {
      sessions: {
        refreshAccessToken: {
          execute: async () => {
            await Promise.resolve();
            refreshAttempts += 1;
            if (refreshAttempts > 1) {
              const resetAt = Date.now() + 25_000;
              throw new RateLimitExceededError(
                { action: "refresh-token", identifier: "127.0.0.1" },
                resetAt,
                1,
              );
            }
            return {
              type: "ok",
              value: {
                accessToken: "new-access-token",
                refreshToken: "new-refresh-token",
              },
            };
          },
        },
      },
      credentials: {
        authenticateWithPassword: {
          execute: async () => {
            await Promise.resolve();
            loginAttempts += 1;
            if (loginAttempts > 2) {
              const resetAt = Date.now() + 30_000;
              throw new RateLimitExceededError(
                { action: "login", identifier: "alice@example.com" },
                resetAt,
                2,
              );
            }
            return {
              type: "failure",
              error: new Error("invalid credentials"),
            };
          },
        },
        registerUserWithPassword: {
          execute: async () => {
            await Promise.resolve();
            registerAttempts += 1;
            if (registerAttempts > 1) {
              const resetAt = Date.now() + 45_000;
              throw new RateLimitExceededError(
                { action: "register", identifier: "bob@example.com" },
                resetAt,
                1,
              );
            }
            return {
              type: "failure",
              error: new Error("registration failed"),
            };
          },
        },
        requestPasswordReset: {
          execute: async () => {
            await Promise.resolve();
            forgotPasswordAttempts += 1;
            if (forgotPasswordAttempts > 1) {
              const resetAt = Date.now() + 20_000;
              throw new RateLimitExceededError(
                { action: "password-reset", identifier: "carol@example.com" },
                resetAt,
                1,
              );
            }
            return {
              type: "failure",
              error: new Error("request failed"),
            };
          },
        },
        confirmPasswordReset: {
          execute: async () => {
            await Promise.resolve();
            resetPasswordAttempts += 1;
            if (resetPasswordAttempts > 1) {
              const resetAt = Date.now() + 15_000;
              throw new RateLimitExceededError(
                { action: "password-reset", identifier: "token-123" },
                resetAt,
                1,
              );
            }
            return {
              type: "failure",
              error: new Error("reset failed"),
            };
          },
        },
      },
      audit: {
        recordEvent: {
          execute: async () => {
            await Promise.resolve();
          },
        },
      },
    } as unknown as Container;

    registerAuthRoutes(app, mockContainer);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns 429 with standard headers when /login rate limit is exceeded", async () => {
    // Attempt 1: under limit
    await supertest(app.server)
      .post("/login")
      .send({ email: "alice@example.com", password: "Password123!" });

    // Attempt 2: at limit
    await supertest(app.server)
      .post("/login")
      .send({ email: "alice@example.com", password: "Password123!" });

    // Attempt 3: exceeds limit -> 429
    const res = await supertest(app.server)
      .post("/login")
      .send({ email: "alice@example.com", password: "Password123!" });

    expect(res.status).toBe(429);
    expect(res.headers["x-ratelimit-limit"]).toBe("2");
    expect(res.headers["x-ratelimit-remaining"]).toBe("0");
    expect(res.headers["x-ratelimit-reset"]).toBeDefined();
    expect(res.headers["retry-after"]).toBeDefined();
    expect((res.body as ApiErrorBody).error.code).toBe("RATE_LIMITED");
  });

  it("returns 429 with standard headers when /register rate limit is exceeded", async () => {
    // Attempt 1: under limit
    await supertest(app.server).post("/register").send({
      email: "bob@example.com",
      displayName: "Bob",
      password: "Password123!",
    });

    // Attempt 2: exceeds limit -> 429
    const res = await supertest(app.server).post("/register").send({
      email: "bob@example.com",
      displayName: "Bob",
      password: "Password123!",
    });

    expect(res.status).toBe(429);
    expect(res.headers["x-ratelimit-limit"]).toBe("1");
    expect(res.headers["x-ratelimit-remaining"]).toBe("0");
    expect(res.headers["retry-after"]).toBeDefined();
    expect((res.body as ApiErrorBody).error.code).toBe("RATE_LIMITED");
  });

  it("returns 429 with standard headers when /forgot-password rate limit is exceeded", async () => {
    await supertest(app.server).post("/forgot-password").send({
      email: "carol@example.com",
    });

    const res = await supertest(app.server).post("/forgot-password").send({
      email: "carol@example.com",
    });

    expect(res.status).toBe(429);
    expect(res.headers["x-ratelimit-limit"]).toBe("1");
    expect(res.headers["x-ratelimit-remaining"]).toBe("0");
    expect(res.headers["retry-after"]).toBeDefined();
    expect((res.body as ApiErrorBody).error.code).toBe("RATE_LIMITED");
  });

  it("returns 429 with standard headers when /reset-password rate limit is exceeded", async () => {
    await supertest(app.server).post("/reset-password").send({
      token: "valid-token-xyz",
      newPassword: "NewPassword123!",
    });

    const res = await supertest(app.server).post("/reset-password").send({
      token: "valid-token-xyz",
      newPassword: "NewPassword123!",
    });

    expect(res.status).toBe(429);
    expect(res.headers["x-ratelimit-limit"]).toBe("1");
    expect(res.headers["x-ratelimit-remaining"]).toBe("0");
    expect(res.headers["retry-after"]).toBeDefined();
    expect((res.body as ApiErrorBody).error.code).toBe("RATE_LIMITED");
  });

  it("returns 429 with standard headers when /refresh rate limit is exceeded without revealing token validity", async () => {
    // Attempt 1: under limit
    const res1 = await supertest(app.server).post("/refresh").send({
      refreshToken: "token-1",
    });
    expect(res1.status).toBe(200);

    // Attempt 2: exceeds limit -> 429
    const res2 = await supertest(app.server).post("/refresh").send({
      refreshToken: "token-2",
    });

    expect(res2.status).toBe(429);
    expect(res2.headers["x-ratelimit-limit"]).toBe("1");
    expect(res2.headers["x-ratelimit-remaining"]).toBe("0");
    expect(res2.headers["retry-after"]).toBeDefined();
    expect((res2.body as ApiErrorBody).error.code).toBe("RATE_LIMITED");
  });
});
