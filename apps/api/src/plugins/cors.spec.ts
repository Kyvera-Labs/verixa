import { ConfigError } from "@verixa/config";
import Fastify from "fastify";
import supertest from "supertest";
import { describe, expect, it } from "vitest";

import { handleApiError } from "../http/error-response.js";

import {
  corsPolicyFromConfig,
  isOriginAllowed,
  NO_CORS,
  registerCors,
  type CorsPolicy,
} from "./cors.js";

/**
 * Unit coverage for the CORS policy mapping (Issue 204).
 *
 * The HTTP behaviour — which responses carry `Access-Control-*` headers and
 * which requests are refused — lives in `tests/integration/cors.spec.ts`. This
 * file covers the pure decisions that do not need a socket: what a validated
 * environment maps onto, and the exact-match rule the whole policy rests on.
 */
describe("corsPolicyFromConfig", () => {
  it("maps the validated environment onto the policy", () => {
    expect(
      corsPolicyFromConfig({
        CORS_ALLOWED_ORIGINS: ["https://app.example.com"],
        CORS_ALLOW_CREDENTIALS: true,
      }),
    ).toEqual({
      allowedOrigins: ["https://app.example.com"],
      allowCredentials: true,
    });
  });

  it("throws for the wildcard-plus-credentials pairing", () => {
    // `loadConfig` already rejects this, but a policy can be constructed
    // directly (tests first among them), and this is the mistake someone makes
    // by hand.
    expect(() =>
      corsPolicyFromConfig({ CORS_ALLOWED_ORIGINS: ["*"], CORS_ALLOW_CREDENTIALS: true }),
    ).toThrowError(ConfigError);

    try {
      corsPolicyFromConfig({ CORS_ALLOWED_ORIGINS: ["*"], CORS_ALLOW_CREDENTIALS: true });
      expect.unreachable("corsPolicyFromConfig should have thrown");
    } catch (error) {
      const message = (error as ConfigError).message;
      expect(message).toContain("CORS_ALLOWED_ORIGINS");
      expect(message).toContain("CORS_ALLOW_CREDENTIALS");
    }
  });
});

describe("isOriginAllowed", () => {
  const restricted: CorsPolicy = {
    allowedOrigins: ["https://app.example.com", "http://localhost:5173"],
    allowCredentials: false,
  };

  it("allows an exactly listed origin", () => {
    expect(isOriginAllowed("https://app.example.com", restricted)).toBe(true);
    expect(isOriginAllowed("http://localhost:5173", restricted)).toBe(true);
  });

  it("refuses a lookalike origin", () => {
    // The entire security property in one test: suffix and hostname matches
    // are how `evil-app.example.com` gets treated as `app.example.com`.
    expect(isOriginAllowed("https://evil-app.example.com", restricted)).toBe(false);
    expect(isOriginAllowed("https://app.example.com.evil.test", restricted)).toBe(false);
    expect(isOriginAllowed("https://app.example.com:8443", restricted)).toBe(false);
    expect(isOriginAllowed("http://app.example.com", restricted)).toBe(false);
  });

  it("allows every origin under the wildcard, including nothing-listed", () => {
    expect(isOriginAllowed("https://anything.example", NO_CORS)).toBe(false);
    expect(
      isOriginAllowed("https://anything.example", {
        allowedOrigins: ["*"],
        allowCredentials: false,
      }),
    ).toBe(true);
  });
});

describe("registerCors", () => {
  it("allows cross-origin requests from allow-listed origins with credentials", async () => {
    const app = Fastify();
    app.setErrorHandler(handleApiError);
    registerCors(app, {
      allowedOrigins: ["https://trusted.verixa.io"],
      allowCredentials: true,
    });

    app.get("/test", () => ({ status: "ok" }));
    await app.ready();

    const response = await supertest(app.server)
      .get("/test")
      .set("Origin", "https://trusted.verixa.io");

    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("https://trusted.verixa.io");
    expect(response.headers["access-control-allow-credentials"]).toBe("true");

    await app.close();
  });

  it("rejects cross-origin requests from non-allow-listed origins", async () => {
    const app = Fastify();
    app.setErrorHandler(handleApiError);
    registerCors(app, {
      allowedOrigins: ["https://trusted.verixa.io"],
      allowCredentials: true,
    });

    app.get("/test", () => ({ status: "ok" }));
    await app.ready();

    const response = await supertest(app.server)
      .get("/test")
      .set("Origin", "https://evil-attacker.com");

    expect(response.status).not.toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();

    await app.close();
  });

  it("handles preflight OPTIONS requests for allowed origins", async () => {
    const app = Fastify();
    app.setErrorHandler(handleApiError);
    registerCors(app, {
      allowedOrigins: ["https://trusted.verixa.io"],
      allowCredentials: true,
    });

    app.post("/test", () => ({ status: "ok" }));
    await app.ready();

    const response = await supertest(app.server)
      .options("/test")
      .set("Origin", "https://trusted.verixa.io")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "Content-Type,Authorization");

    expect(response.status).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe("https://trusted.verixa.io");
    expect(response.headers["access-control-allow-credentials"]).toBe("true");

    await app.close();
  });
});
