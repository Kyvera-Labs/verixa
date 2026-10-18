import { ConfigError } from "@verixa/config";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp, type SecurityHeadersOptions } from "../app.js";

import {
  DEFAULT_HSTS_MAX_AGE_SECONDS,
  formatHstsHeader,
  httpsRedirectTarget,
  isRedirectableHost,
  securityHeadersFromConfig,
  type TransportSecurityConfig,
} from "./security-headers.js";

const productionHsts: SecurityHeadersOptions = {
  hsts: { maxAgeSeconds: 31_536_000, includeSubDomains: true, preload: false },
  enforceHttps: false,
};

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
  const app = buildApp({ securityHeaders: productionHsts });

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

/**
 * Builds a transport-security config from defaults rather than from a partial
 * literal, so a test that only cares about `HSTS_PRELOAD` still has to say so
 * and cannot silently inherit a second changed default.
 */
const config = (overrides: {
  readonly nodeEnv?: "development" | "test" | "production";
  readonly maxAgeSeconds?: number;
  readonly includeSubDomains?: boolean;
  readonly preload?: boolean;
  readonly enforceHttps?: boolean;
}): TransportSecurityConfig => ({
  NODE_ENV: overrides.nodeEnv ?? "production",
  HSTS_MAX_AGE_SECONDS: overrides.maxAgeSeconds ?? DEFAULT_HSTS_MAX_AGE_SECONDS,
  HSTS_INCLUDE_SUBDOMAINS: overrides.includeSubDomains ?? true,
  HSTS_PRELOAD: overrides.preload ?? false,
  ENFORCE_HTTPS: overrides.enforceHttps ?? false,
});

describe("formatHstsHeader", () => {
  it("emits max-age alone when neither flag is set", () => {
    expect(
      formatHstsHeader({ maxAgeSeconds: 31_536_000, includeSubDomains: false, preload: false }),
    ).toBe("max-age=31536000");
  });

  it("appends includeSubDomains", () => {
    expect(
      formatHstsHeader({ maxAgeSeconds: 31_536_000, includeSubDomains: true, preload: false }),
    ).toBe("max-age=31536000; includeSubDomains");
  });

  it("appends preload", () => {
    expect(
      formatHstsHeader({ maxAgeSeconds: 63_072_000, includeSubDomains: false, preload: true }),
    ).toBe("max-age=63072000; preload");
  });

  it("emits both flags in the order the preload submission format expects", () => {
    expect(
      formatHstsHeader({ maxAgeSeconds: 63_072_000, includeSubDomains: true, preload: true }),
    ).toBe("max-age=63072000; includeSubDomains; preload");
  });

  it("emits max-age=0 rather than nothing, so an existing pin is actually cleared", () => {
    // The RFC-recommended way to undo a pin. Omitting the header leaves every
    // previous visitor pinned until their own max-age runs out.
    expect(formatHstsHeader({ maxAgeSeconds: 0, includeSubDomains: false, preload: false })).toBe(
      "max-age=0",
    );
  });

  it.each<[number, string]>([
    [-1, "a negative max-age"],
    [1.5, "a fractional max-age"],
    [63_072_001, "a max-age past the two-year ceiling"],
    [Number.NaN, "a max-age that is not a number"],
  ])("refuses %s — %s", (maxAgeSeconds) => {
    // `HstsDirective` is exported, so nothing guarantees its caller came
    // through the environment schema. A nonsense value would otherwise reach a
    // browser's security state, where the damage is not a bad response but a
    // pin nobody can take back.
    expect(() =>
      formatHstsHeader({
        maxAgeSeconds,
        includeSubDomains: true,
        preload: false,
      }),
    ).toThrow(RangeError);
  });
});

describe("securityHeadersFromConfig", () => {
  it("turns the header on in production with the configured directive", () => {
    expect(securityHeadersFromConfig(config({}))).toEqual({
      hsts: {
        maxAgeSeconds: DEFAULT_HSTS_MAX_AGE_SECONDS,
        includeSubDomains: true,
        preload: false,
      },
      enforceHttps: false,
    });
  });

  it("leaves the header off in development, whatever the variables say", () => {
    // An HSTS pin on `localhost` is self-inflicted: a developer who probes the
    // HTTPS listener once with a self-signed certificate gets a browser that
    // refuses plaintext to that origin for the whole max-age. The environment,
    // not the operator's memory, is what keeps development out of that hole.
    const result = securityHeadersFromConfig(
      config({ nodeEnv: "development", maxAgeSeconds: 63_072_000, preload: false }),
    );

    expect(result.hsts).toBeNull();
  });

  it("leaves the header off under test", () => {
    expect(securityHeadersFromConfig(config({ nodeEnv: "test" })).hsts).toBeNull();
  });

  it("carries ENFORCE_HTTPS into both environments", () => {
    // Unlike the pin, the redirect cannot hurt a developer: nothing is stored
    // in the browser, so the mistake is visible and immediately reversible.
    expect(
      securityHeadersFromConfig(config({ nodeEnv: "development", enforceHttps: true })),
    ).toEqual({ hsts: null, enforceHttps: true });
  });

  it("refuses preload without includeSubDomains", () => {
    // The preload list rejects such a directive, so the configuration is one
    // that looks like a commitment and can never be kept. Failing at startup
    // is the only moment anyone can still act on it.
    expect(() =>
      securityHeadersFromConfig(config({ preload: true, includeSubDomains: false })),
    ).toThrowError(ConfigError);

    try {
      securityHeadersFromConfig(config({ preload: true, includeSubDomains: false }));
      expect.unreachable("should have thrown");
    } catch (error) {
      const message = (error as ConfigError).message;
      expect(message).toContain("HSTS_PRELOAD");
      expect(message).toContain("HSTS_INCLUDE_SUBDOMAINS");
    }
  });

  it("accepts preload with includeSubDomains and puts the flag on the directive", () => {
    const result = securityHeadersFromConfig(
      config({ preload: true, includeSubDomains: true, maxAgeSeconds: 63_072_000 }),
    );

    expect(result.hsts).toEqual({
      maxAgeSeconds: 63_072_000,
      includeSubDomains: true,
      preload: true,
    });
  });
});

describe("isRedirectableHost", () => {
  it.each([
    "example.com",
    "api.example.com",
    "verixa.test",
    "localhost",
    "localhost:3000",
    "127.0.0.1:3000",
    "[::1]:3000",
    "[2001:db8::1]",
    "upstream-42.example.com",
  ])("accepts %j", (host) => {
    expect(isRedirectableHost(host)).toBe(true);
  });

  it.each([
    // A second authority separator: `evil.com` becomes the redirect target
    // once any downstream component normalizes the URL.
    "example.com@evil.com",
    // Path, query and fragment characters have no business in a Host, and a
    // `/` here is how a redirect escapes to an attacker's path.
    "example.com/evil",
    "example.com?x=1",
    "example.com#x",
    // Whitespace and control characters — including the CR/LF pair that would
    // be a response-splitting attempt if the HTTP parser ever let it through.
    "exa mple.com",
    "example.com\r\nx-fast: 1",
    "",
    ".example.com",
    "example.com.",
    "-example.com",
    "example.com--",
    ":3000",
    "xn--",
  ])("rejects %j", (host) => {
    expect(isRedirectableHost(host)).toBe(false);
  });

  it("rejects an absent Host header", () => {
    expect(isRedirectableHost(undefined)).toBe(false);
  });

  it("rejects a Host longer than the maximum legal hostname", () => {
    const labels = Array.from({ length: 60 }, (_, i) => `label${i.toString().padStart(2, "0")}`);
    const long = `${labels.join(".")}.com`;

    expect(long.length).toBeGreaterThan(253);
    expect(isRedirectableHost(long)).toBe(false);
  });
});

describe("httpsRedirectTarget", () => {
  it("rebuilds the same path and query on https", () => {
    expect(httpsRedirectTarget("app.example.com", "/auth/login")).toBe(
      "https://app.example.com/auth/login",
    );
    expect(httpsRedirectTarget("app.example.com:8443", "/health?verbose=1")).toBe(
      "https://app.example.com:8443/health?verbose=1",
    );
  });

  it("refuses a Host it would be unsafe to echo", () => {
    expect(httpsRedirectTarget("example.com@evil.com", "/health")).toBeUndefined();
  });

  it("refuses a URL that is not origin-form", () => {
    // `//evil.com` is protocol-relative: `https://host//evil.com` is safe, but
    // the same value handed to a downstream normalizer is not, so a
    // request-target that does not begin with a single `/` is refused outright.
    expect(httpsRedirectTarget("example.com", "//evil.com/path")).toBeUndefined();
    expect(httpsRedirectTarget("example.com", "https://example.com/x")).toBeUndefined();
    expect(httpsRedirectTarget("example.com", "")).toBeUndefined();
  });
});
