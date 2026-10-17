import { ConfigError } from "@verixa/config";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_HSTS_MAX_AGE_SECONDS,
  formatHstsHeader,
  httpsRedirectTarget,
  isRedirectableHost,
  securityHeadersFromConfig,
  type TransportSecurityConfig,
} from "./security-headers.js";

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
