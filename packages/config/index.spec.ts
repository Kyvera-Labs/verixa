import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "./index.js";

const VALID_SESSION_SECRET = "a".repeat(32);

describe("loadConfig", () => {
  it("produces a typed config object from a fully-specified environment", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      PORT: "8080",
      HOST: "127.0.0.1",
      LOG_LEVEL: "warn",
      DATABASE_URL: "postgres://user:pass@db.example.com:5432/verixa",
      REDIS_URL: "redis://redis.example.com:6379",
      SESSION_ACCESS_TOKEN_SECRET: VALID_SESSION_SECRET,
    });

    expect(config).toEqual({
      NODE_ENV: "production",
      PORT: 8080,
      HOST: "127.0.0.1",
      LOG_LEVEL: "warn",
      DATABASE_URL: "postgres://user:pass@db.example.com:5432/verixa",
      DATABASE_POOL_SIZE: 10,
      DATABASE_POOL_TIMEOUT_SECONDS: 10,
      REDIS_URL: "redis://redis.example.com:6379",
      SESSION_ACCESS_TOKEN_SECRET: VALID_SESSION_SECRET,
      SESSION_MAX_CONCURRENT_SESSIONS: 0,
      HSTS_MAX_AGE_SECONDS: 31_536_000,
      HSTS_INCLUDE_SUBDOMAINS: true,
      HSTS_PRELOAD: false,
      ENFORCE_HTTPS: false,
      TRUST_PROXY: false,
      MFA_ENFORCEMENT_LEVEL: "optional",
      MFA_ALLOWED_METHODS: [],
    });
  });

  it("coerces PORT from a string to a number", () => {
    const config = loadConfig({
      PORT: "4000",
      SESSION_ACCESS_TOKEN_SECRET: VALID_SESSION_SECRET,
    });

    expect(config.PORT).toBe(4000);
    expect(typeof config.PORT).toBe("number");
  });

  it("applies defaults when optional variables are missing", () => {
    const config = loadConfig({ SESSION_ACCESS_TOKEN_SECRET: VALID_SESSION_SECRET });

    expect(config).toEqual({
      NODE_ENV: "development",
      PORT: 3000,
      HOST: "0.0.0.0",
      LOG_LEVEL: "info",
      DATABASE_URL: "postgres://verixa:verixa@localhost:5432/verixa",
      DATABASE_POOL_SIZE: 10,
      DATABASE_POOL_TIMEOUT_SECONDS: 10,
      REDIS_URL: "redis://localhost:6379",
      SESSION_ACCESS_TOKEN_SECRET: VALID_SESSION_SECRET,
      SESSION_MAX_CONCURRENT_SESSIONS: 0,
      HSTS_MAX_AGE_SECONDS: 31_536_000,
      HSTS_INCLUDE_SUBDOMAINS: true,
      HSTS_PRELOAD: false,
      ENFORCE_HTTPS: false,
      TRUST_PROXY: false,
      MFA_ENFORCEMENT_LEVEL: "optional",
      MFA_ALLOWED_METHODS: [],
    });
  });

  it("returns an immutable object", () => {
    const config = loadConfig({ SESSION_ACCESS_TOKEN_SECRET: VALID_SESSION_SECRET });

    expect(() => {
      // @ts-expect-error — the returned config is Readonly; this must fail to typecheck too.
      config.PORT = 9999;
    }).toThrow(TypeError);
  });

  it("throws a ConfigError listing every invalid field when values are malformed", () => {
    expect(() => loadConfig({ NODE_ENV: "staging", PORT: "not-a-number", HOST: "" })).toThrowError(
      ConfigError,
    );

    try {
      loadConfig({ NODE_ENV: "staging", PORT: "not-a-number", HOST: "" });
      expect.unreachable("loadConfig should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as ConfigError).message;
      expect(message).toContain("NODE_ENV");
      expect(message).toContain("PORT");
      expect(message).toContain("HOST");
    }
  });

  it("rejects a port outside the valid TCP range", () => {
    expect(() =>
      loadConfig({ PORT: "70000", SESSION_ACCESS_TOKEN_SECRET: VALID_SESSION_SECRET }),
    ).toThrowError(ConfigError);
  });

  it("coerces pool settings from strings and applies defaults", () => {
    const config = loadConfig({
      DATABASE_POOL_SIZE: "25",
      SESSION_ACCESS_TOKEN_SECRET: VALID_SESSION_SECRET,
    });

    expect(config.DATABASE_POOL_SIZE).toBe(25);
    expect(config.DATABASE_POOL_TIMEOUT_SECONDS).toBe(10);
  });

  it("rejects a pool size above a stock Postgres max_connections", () => {
    // Above ~100 the failure mode changes from "requests queue" to
    // "connections are refused outright", which is much harder to diagnose.
    expect(() =>
      loadConfig({ DATABASE_POOL_SIZE: "500", SESSION_ACCESS_TOKEN_SECRET: VALID_SESSION_SECRET }),
    ).toThrowError(ConfigError);
  });

  it("rejects a non-positive pool size", () => {
    expect(() =>
      loadConfig({ DATABASE_POOL_SIZE: "0", SESSION_ACCESS_TOKEN_SECRET: VALID_SESSION_SECRET }),
    ).toThrowError(ConfigError);
  });

  it("rejects a malformed DATABASE_URL", () => {
    expect(() =>
      loadConfig({ DATABASE_URL: "not-a-url", SESSION_ACCESS_TOKEN_SECRET: VALID_SESSION_SECRET }),
    ).toThrowError(ConfigError);
  });

  it("applies the default REDIS_URL when missing", () => {
    const config = loadConfig({ SESSION_ACCESS_TOKEN_SECRET: VALID_SESSION_SECRET });

    expect(config.REDIS_URL).toBe("redis://localhost:6379");
  });

  it("rejects a malformed REDIS_URL", () => {
    expect(() =>
      loadConfig({ REDIS_URL: "not-a-url", SESSION_ACCESS_TOKEN_SECRET: VALID_SESSION_SECRET }),
    ).toThrowError(ConfigError);
  });

  it("requires SESSION_ACCESS_TOKEN_SECRET, with no default", () => {
    expect(() => loadConfig({})).toThrowError(ConfigError);

    try {
      loadConfig({});
      expect.unreachable("loadConfig should have thrown");
    } catch (error) {
      expect((error as ConfigError).message).toContain("SESSION_ACCESS_TOKEN_SECRET");
    }
  });

  it("rejects a SESSION_ACCESS_TOKEN_SECRET shorter than 32 characters", () => {
    expect(() => loadConfig({ SESSION_ACCESS_TOKEN_SECRET: "too-short" })).toThrowError(
      ConfigError,
    );
  });

  it("accepts a SESSION_ACCESS_TOKEN_SECRET of exactly 32 characters", () => {
    const config = loadConfig({ SESSION_ACCESS_TOKEN_SECRET: VALID_SESSION_SECRET });

    expect(config.SESSION_ACCESS_TOKEN_SECRET).toBe(VALID_SESSION_SECRET);
  });

  it("defaults SESSION_MAX_CONCURRENT_SESSIONS to 0 (disabled)", () => {
    const config = loadConfig({ SESSION_ACCESS_TOKEN_SECRET: VALID_SESSION_SECRET });

    expect(config.SESSION_MAX_CONCURRENT_SESSIONS).toBe(0);
  });

  it("coerces SESSION_MAX_CONCURRENT_SESSIONS from a string", () => {
    const config = loadConfig({
      SESSION_ACCESS_TOKEN_SECRET: VALID_SESSION_SECRET,
      SESSION_MAX_CONCURRENT_SESSIONS: "3",
    });

    expect(config.SESSION_MAX_CONCURRENT_SESSIONS).toBe(3);
    expect(typeof config.SESSION_MAX_CONCURRENT_SESSIONS).toBe("number");
  });

  it("rejects a negative SESSION_MAX_CONCURRENT_SESSIONS", () => {
    expect(() => loadConfig({ SESSION_MAX_CONCURRENT_SESSIONS: "-1" })).toThrowError(ConfigError);
  });

  it("parses ENFORCE_HTTPS=false as false, not as a truthy string", () => {
    // The regression this guards is the reason `booleanFromEnv` exists:
    // `z.coerce.boolean()` would have read the literal string "false" as true
    // and turned the operator's opt-out into an opt-in.
    const config = loadConfig({
      SESSION_ACCESS_TOKEN_SECRET: VALID_SESSION_SECRET,
      ENFORCE_HTTPS: "false",
      HSTS_PRELOAD: "0",
      TRUST_PROXY: "false",
    });

    expect(config.ENFORCE_HTTPS).toBe(false);
    expect(config.HSTS_PRELOAD).toBe(false);
    expect(config.TRUST_PROXY).toBe(false);
  });

  it("parses the accepted truthy spellings of the transport-security flags", () => {
    const config = loadConfig({
      SESSION_ACCESS_TOKEN_SECRET: VALID_SESSION_SECRET,
      ENFORCE_HTTPS: "true",
      HSTS_INCLUDE_SUBDOMAINS: "1",
    });

    expect(config.ENFORCE_HTTPS).toBe(true);
    expect(config.HSTS_INCLUDE_SUBDOMAINS).toBe(true);
  });

  it("rejects an ambiguous boolean instead of guessing", () => {
    // "yes" is the value someone reaches for when a flag is not documented.
    // Accepting it would make the same deployment mean two different things to
    // two different operators, so it fails at startup and names itself.
    expect(() =>
      loadConfig({
        SESSION_ACCESS_TOKEN_SECRET: VALID_SESSION_SECRET,
        ENFORCE_HTTPS: "yes",
      }),
    ).toThrowError(ConfigError);

    expect(() =>
      loadConfig({
        SESSION_ACCESS_TOKEN_SECRET: VALID_SESSION_SECRET,
        ENFORCE_HTTPS: "TRUE",
      }),
    ).toThrowError(ConfigError);
  });

  it("defaults the transport-security flags to the production-safe-but-inert posture", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      SESSION_ACCESS_TOKEN_SECRET: VALID_SESSION_SECRET,
    });

    expect(config.HSTS_MAX_AGE_SECONDS).toBe(31_536_000);
    expect(config.HSTS_INCLUDE_SUBDOMAINS).toBe(true);
    // Two flags with hard-to-reverse consequences are never defaulted on.
    expect(config.HSTS_PRELOAD).toBe(false);
    expect(config.ENFORCE_HTTPS).toBe(false);
    expect(config.TRUST_PROXY).toBe(false);
  });

  it("coerces HSTS_MAX_AGE_SECONDS from a string", () => {
    const config = loadConfig({
      SESSION_ACCESS_TOKEN_SECRET: VALID_SESSION_SECRET,
      HSTS_MAX_AGE_SECONDS: "86400",
    });

    expect(config.HSTS_MAX_AGE_SECONDS).toBe(86_400);
  });

  it("rejects an HSTS_MAX_AGE_SECONDS beyond the two-year ceiling", () => {
    // A longer pin is not a stronger one: the browser renews it on every
    // response, so an over-long max-age is a promise nobody can take back.
    expect(() =>
      loadConfig({
        SESSION_ACCESS_TOKEN_SECRET: VALID_SESSION_SECRET,
        HSTS_MAX_AGE_SECONDS: "99999999999",
      }),
    ).toThrowError(ConfigError);
  });

  it("rejects a fractional or negative HSTS_MAX_AGE_SECONDS", () => {
    expect(() =>
      loadConfig({
        SESSION_ACCESS_TOKEN_SECRET: VALID_SESSION_SECRET,
        HSTS_MAX_AGE_SECONDS: "-1",
      }),
    ).toThrowError(ConfigError);

    expect(() =>
      loadConfig({
        SESSION_ACCESS_TOKEN_SECRET: VALID_SESSION_SECRET,
        HSTS_MAX_AGE_SECONDS: "1.5",
      }),
    ).toThrowError(ConfigError);
  });
});
