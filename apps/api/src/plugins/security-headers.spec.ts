import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";

/**
 * Integration coverage for the global security-headers plugin (Issue 203).
 *
 * These assert on real HTTP responses rather than on the config object, since
 * the property that matters is "every response a client can receive carries
 * these headers" — which depends on Fastify's hook inheritance and helmet's
 * serialisation, neither of which a unit test of the options would exercise.
 *
 * `/health` is the sample route because it is the one endpoint guaranteed to
 * exist without a database: `buildApp()` with no container registers it and
 * nothing else, so this suite runs on a fresh clone the same way `app.spec.ts`
 * does.
 */
describe("security headers", () => {
  const app = buildApp();

  beforeAll(async () => {
    // A route inside an explicitly encapsulated child scope — the shape every
    // future `@fastify/*` plugin and prefixed route group will use. If helmet's
    // hook did not reach child scopes, headers would silently stop applying the
    // moment someone registered a plugin, which is the failure this test exists
    // to catch.
    app.register((scope) => {
      scope.get("/__encapsulated-probe__", () => ({ probe: true }));
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("on a route handler response", () => {
    it("sets the full configured header set", async () => {
      const response = await supertest(app.server).get("/health");

      expect(response.status).toBe(200);
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["x-frame-options"]).toBe("DENY");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(response.headers["strict-transport-security"]).toBe(
        "max-age=31536000; includeSubDomains",
      );
      // Asserted even though helmet sends it by default: pinning the value is
      // what makes an unexplained upgrade in a later helmet release a reviewable
      // failure rather than a silent policy change.
      expect(response.headers["x-xss-protection"]).toBe("0");
    });

    it("sends a CSP that allows no subresource and no inline script", async () => {
      const response = await supertest(app.server).get("/health");
      const csp = response.headers["content-security-policy"];

      expect(csp).toBeDefined();
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("base-uri 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      // The point of `useDefaults: false`: helmet's own baseline would carry
      // `script-src 'self'` and an inline-style allowance for pages this API
      // does not serve.
      expect(csp).not.toContain("unsafe-inline");
      expect(csp).not.toContain("unsafe-eval");
    });

    it("does not advertise the stack", async () => {
      const response = await supertest(app.server).get("/health");

      // Fastify does not send `X-Powered-By` on its own, so this passes today
      // with or without the plugin. It stays because `hidePoweredBy` is part of
      // the configured header set, and the way that header comes back is a
      // transitive plugin or a proxy config nobody reviewed — not this file.
      expect(response.headers["x-powered-by"]).toBeUndefined();
    });
  });

  it("applies to routes in encapsulated child scopes", async () => {
    const response = await supertest(app.server).get("/__encapsulated-probe__");

    expect(response.status).toBe(200);
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
  });

  it("applies to error responses too", async () => {
    // A 404 is produced by Fastify's not-found handler, not by a route, and an
    // attacker probing for endpoints sees it. Probing whether a deployment
    // exposes `/verification/review-queue` is a real information leak, so the
    // headers have to be set on the paths that do not exist as well.
    const response = await supertest(app.server).get("/does-not-exist");

    expect(response.status).toBe(404);
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["strict-transport-security"]).toContain("max-age=31536000");
  });
});
