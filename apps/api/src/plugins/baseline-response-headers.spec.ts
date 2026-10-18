import { fileURLToPath } from "node:url";

import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import Fastify from "fastify";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DOCS_CONTENT_SECURITY_POLICY,
  registerBaselineResponseHeaders,
} from "./baseline-response-headers.js";

/**
 * Coverage for the global baseline response headers (Issue 203).
 *
 * These assert on real HTTP responses rather than on the options object, since
 * the property that matters is "every response a client can receive carries
 * these headers" — which depends on Fastify's hook inheritance and helmet's
 * serialisation, neither of which reading `BASELINE_RESPONSE_HEADERS` back would
 * exercise.
 *
 * The fixture below is a fixture rather than `buildApp()` for one reason, and it
 * is a real limitation worth stating plainly: `buildApp()` cannot be imported
 * while `main` carries the parse errors in `../routes/verification.ts` and
 * `../../../../packages/authorization/interface/admin-roles.routes.ts`, so this
 * suite would be red for someone else's syntax. What that costs is the
 * integration claim — that `buildApp()` really registers this plugin, and that
 * `app.ts` really passes `DOCS_CONTENT_SECURITY_POLICY` as swagger-ui's
 * `staticCSP`. Both are one line to read in `../app.ts`, and the wiring here
 * deliberately mirrors those two lines so that the header behaviour asserted
 * below is the behaviour that wiring produces. If that mirror stops matching,
 * the `/docs` tests in this file are asserting a fiction: keep them in step.
 */
function buildHeaderFixture() {
  const app = Fastify({ logger: false });

  registerBaselineResponseHeaders(app);

  app.register((scope) => {
    scope.get("/__encapsulated-probe__", () => ({ probe: true }));
  });

  app.register(fastifySwagger, {
    mode: "static",
    specification: {
      path: fileURLToPath(new URL("../../openapi/openapi.yaml", import.meta.url)),
      baseDir: fileURLToPath(new URL("../../openapi", import.meta.url)),
    },
  });
  app.register(fastifySwaggerUi, {
    routePrefix: "/docs",
    staticCSP: DOCS_CONTENT_SECURITY_POLICY,
    uiConfig: { docExpansion: "list", deepLinking: true, url: "/docs/openapi.json" },
  });
  app.get("/docs/openapi.json", () => app.swagger());

  app.get("/health", () => ({ status: "ok" }));

  return app;
}

/** The headers every response carries, apart from the CSP that varies by route. */
const HEADER_NAMES = [
  "x-content-type-options",
  "x-frame-options",
  "referrer-policy",
  "x-permitted-cross-domain-policies",
  "x-dns-prefetch-control",
  "x-download-options",
  "origin-agent-cluster",
  "x-xss-protection",
] as const;

describe("baseline response headers", () => {
  const app = buildHeaderFixture();

  beforeAll(async () => {
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("on a route handler response", () => {
    it("sets the configured header set", async () => {
      const response = await supertest(app.server).get("/health");

      expect(response.status).toBe(200);
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["x-frame-options"]).toBe("DENY");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(response.headers["x-permitted-cross-domain-policies"]).toBe("none");
      expect(response.headers["x-dns-prefetch-control"]).toBe("off");
      expect(response.headers["x-download-options"]).toBe("noopen");
      expect(response.headers["origin-agent-cluster"]).toBe("?1");
      // Asserted even though helmet sends it by default: pinning the value is
      // what makes an unexplained upgrade in a later helmet release a reviewable
      // failure rather than a silent policy change.
      expect(response.headers["x-xss-protection"]).toBe("0");
    });

    it("sends a CSP that allows no subresource and no inline script", async () => {
      const csp = String(
        (await supertest(app.server).get("/health")).headers["content-security-policy"],
      );

      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("base-uri 'none'");
      expect(csp).toContain("form-action 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      // The point of `useDefaults: false`: helmet's own baseline would carry
      // `script-src 'self'` and an inline-style allowance for pages this API
      // does not serve.
      expect(csp).not.toContain("unsafe-inline");
      expect(csp).not.toContain("unsafe-eval");
    });

    it("leaves Strict-Transport-Security to the transport-security module", async () => {
      // `hsts: false` in the helmet options. A pin here would mean this module
      // and `./security-headers.ts` (Issue 213) both write the header, so its
      // value would depend on hook ordering rather than on validated config.
      const response = await supertest(app.server).get("/health");

      expect(response.headers["strict-transport-security"]).toBeUndefined();
    });

    it("does not advertise the stack", async () => {
      // Fastify does not send `X-Powered-By` on its own, so this passes today
      // with or without the plugin. It stays because `hidePoweredBy` is part of
      // the configured header set, and the way that header comes back is a
      // transitive plugin or a proxy config nobody reviewed — not this file.
      const response = await supertest(app.server).get("/health");

      expect(response.headers["x-powered-by"]).toBeUndefined();
    });
  });

  it("applies to routes in encapsulated child scopes", async () => {
    // The shape every future `@fastify/*` plugin and prefixed route group uses.
    // If helmet's hook did not reach child scopes, headers would silently stop
    // applying the moment someone registered a plugin.
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
    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
  });

  describe("on the documentation UI", () => {
    it("serves the page under a policy that can render it", async () => {
      const response = await supertest(app.server).get("/docs/");

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.headers["content-security-policy"]).toBe(DOCS_CONTENT_SECURITY_POLICY);
      // Everything except the CSP is still the baseline: this is one header's
      // exception, not a route that opted out of the policy.
      for (const header of HEADER_NAMES) {
        expect(response.headers[header]).toBeDefined();
      }
    });

    it("applies that policy to the bundle and stylesheet the page loads", async () => {
      // The exception is a prefix, not a single route: a stylesheet or bundle
      // served without it would be a document-bearing response outside the
      // documented scope.
      for (const url of [
        "/docs/static/swagger-ui.css",
        "/docs/static/swagger-initializer.js",
        "/docs/json",
      ]) {
        const response = await supertest(app.server).get(url);

        expect(response.status, url).toBe(200);
        expect(response.headers["content-security-policy"], url).toBe(DOCS_CONTENT_SECURITY_POLICY);
      }
    });

    it("keeps the baseline policy on the JSON served under the same prefix", async () => {
      // `/docs/openapi.json` answers with a JSON body the browser never renders,
      // so it must not inherit the document policy. This is the direction of the
      // exception: scoped to what a browser renders, not to a path.
      const response = await supertest(app.server).get("/docs/openapi.json");

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
    });

    it("reaches no origin that is not this one", () => {
      // The properties that make this tighter than swagger-ui's own
      // `staticCSP: true` policy, asserted on the value rather than on a
      // response so that a future loosening fails here with the reason in the
      // diff: a remote stylesheet is UI redressing, and `validator.swagger.io`
      // is an endpoint that takes this deployment's spec to a third party.
      expect(DOCS_CONTENT_SECURITY_POLICY).not.toContain("'unsafe-inline'");
      expect(DOCS_CONTENT_SECURITY_POLICY).not.toContain("'unsafe-eval'");
      expect(DOCS_CONTENT_SECURITY_POLICY).not.toMatch(/https?:/);
      expect(DOCS_CONTENT_SECURITY_POLICY).not.toContain("validator.swagger.io");
      expect(DOCS_CONTENT_SECURITY_POLICY).toContain("default-src 'self'");
      expect(DOCS_CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
      expect(DOCS_CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    });
  });
});
