import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import {
  GENERAL_API_DEFAULT_POLICY,
  RateLimitPolicyRegistry,
  normalizeRouteName,
  resolveRoutePolicy,
  routePolicyConfigSchema,
} from "./rate-limit-policy.js";

describe("RateLimitPolicy (Issue 315 / 284)", () => {
  describe("route normalization", () => {
    it("normalizes HTTP method and paths to route keys", () => {
      expect(normalizeRouteName("POST /api/auth/login")).toBe("login");
      expect(normalizeRouteName("/login")).toBe("login");
      expect(normalizeRouteName("AUTH_LOGIN")).toBe("login");
      expect(normalizeRouteName("POST /v1/users/register")).toBe("register");
      expect(normalizeRouteName("/signup")).toBe("register");
      expect(normalizeRouteName("POST /auth/password-reset")).toBe("password-reset");
      expect(normalizeRouteName("")).toBe("default");
      expect(normalizeRouteName("/items/list")).toBe("items/list");
    });
  });

  describe("resolveRoutePolicy", () => {
    it("resolves specific defaults for login, register, and password-reset", () => {
      const loginPolicy = resolveRoutePolicy("login");
      expect(loginPolicy.limit).toBe(5);
      expect(loginPolicy.windowMs).toBe(60_000);
      expect(loginPolicy.matchedRoute).toBe("login");

      const registerPolicy = resolveRoutePolicy("register");
      expect(registerPolicy.limit).toBe(3);
      expect(registerPolicy.windowMs).toBe(60_000);
      expect(registerPolicy.matchedRoute).toBe("register");

      const resetPolicy = resolveRoutePolicy("password-reset");
      expect(resetPolicy.limit).toBe(3);
      expect(resetPolicy.windowMs).toBe(60_000);
      expect(resetPolicy.matchedRoute).toBe("password-reset");
    });

    it("falls back to general API default for unknown routes", () => {
      const policy = resolveRoutePolicy("GET /api/v1/unknown-endpoint");
      expect(policy.limit).toBe(GENERAL_API_DEFAULT_POLICY.limit);
      expect(policy.windowMs).toBe(GENERAL_API_DEFAULT_POLICY.windowMs);
      expect(policy.capacity).toBe(GENERAL_API_DEFAULT_POLICY.capacity);
      expect(policy.refillRatePerSecond).toBe(GENERAL_API_DEFAULT_POLICY.refillRatePerSecond);
      expect(policy.matchedRoute).toBe("default");
    });

    it("allows overriding defaults with custom policies", () => {
      const custom = {
        login: {
          limit: 10,
          windowMs: 30_000,
        },
      };

      const resolved = resolveRoutePolicy("login", custom);
      expect(resolved.limit).toBe(10);
      expect(resolved.windowMs).toBe(30_000);
      expect(resolved.capacity).toBe(10); // auto-defaults to limit
      expect(resolved.refillRatePerSecond).toBeCloseTo(10 / 30);
    });
  });

  describe("RateLimitPolicyRegistry", () => {
    it("registers and resolves valid policies", () => {
      const registry = new RateLimitPolicyRegistry({
        "custom-route": {
          limit: 20,
          windowMs: 10_000,
          capacity: 25,
          refillRatePerSecond: 2.5,
        },
      });

      const policy = registry.resolve("custom-route");
      expect(policy.limit).toBe(20);
      expect(policy.capacity).toBe(25);
      expect(policy.refillRatePerSecond).toBe(2.5);
      expect(policy.matchedRoute).toBe("custom-route");

      // Falling back to built-in login
      const login = registry.resolve("POST /login");
      expect(login.limit).toBe(5);

      // Falling back to general default
      const unknown = registry.resolve("something-else");
      expect(unknown.limit).toBe(60);
      expect(unknown.matchedRoute).toBe("default");
    });

    it("fails fast at startup on invalid config schema", () => {
      expect(
        () =>
          new RateLimitPolicyRegistry({
            badRoute: {
              limit: -1, // invalid negative limit
              windowMs: 10_000,
            },
          }),
      ).toThrow(ZodError);

      expect(
        () =>
          new RateLimitPolicyRegistry({
            badRoute: {
              limit: 10,
              windowMs: 500, // invalid window < 1000ms
            },
          }),
      ).toThrow(ZodError);

      expect(
        () =>
          new RateLimitPolicyRegistry({
            badRoute: {
              limit: 10,
              windowMs: 10_000,
              capacity: -5, // invalid capacity
            },
          }),
      ).toThrow(ZodError);
    });
  });

  describe("routePolicyConfigSchema", () => {
    it("validates correct policy inputs", () => {
      const valid = routePolicyConfigSchema.parse({
        limit: 10,
        windowMs: 15_000,
        capacity: 15,
        refillRatePerSecond: 1,
      });
      expect(valid.limit).toBe(10);
      expect(valid.windowMs).toBe(15_000);
    });
  });
});
