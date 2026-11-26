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
      CORS_ALLOWED_ORIGINS: [],
      CORS_ALLOW_CREDENTIALS: false,
      MFA_ENFORCEMENT_LEVEL: "optional",
      MFA_ALLOWED_METHODS: [],
      OTEL_SERVICE_NAME: "verixa-api",
      METRICS_ENABLED: false,
      OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
      OTEL_EXPORTER_OTLP_HEADERS: {},
      OTEL_TRACES_SAMPLER_RATE: 0.1,
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
      CORS_ALLOWED_ORIGINS: [],
      CORS_ALLOW_CREDENTIALS: false,
      MFA_ENFORCEMENT_LEVEL: "optional",
      MFA_ALLOWED_METHODS: [],
      OTEL_SERVICE_NAME: "verixa-api",
      METRICS_ENABLED: false,
      OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
      OTEL_EXPORTER_OTLP_HEADERS: {},
      OTEL_TRACES_SAMPLER_RATE: 1,
    });
  });

  describe("OpenTelemetry OTLP exporter & sampling configuration", () => {
    it("defaults OTEL_TRACES_SAMPLER_RATE to 1.0 in development, 0.1 in production, and 0 in test", () => {
      const dev = loadConfig({
        NODE_ENV: "development",
        SESSION_ACCESS_TOKEN_SECRET: VALID_SESSION_SECRET,
      });
      const prod = loadConfig({
        NODE_ENV: "production",
        SESSION_ACCESS_TOKEN_SECRET: VALID_SESSION_SECRET,
      });
      const test = loadConfig({
        NODE_ENV: "test",
        SESSION_ACCESS_TOKEN_SECRET: VALID_SESSION_SECRET,
      });

      expect(dev.OTEL_TRACES_SAMPLER_RATE).toBe(1);
      expect(prod.OTEL_TRACES_SAMPLER_RATE).toBe(0.1);
      expect(test.OTEL_TRACES_SAMPLER_RATE).toBe(0);
    });

    it("accepts valid OTLP endpoint, protocol, headers, and explicit sampling rate", () => {
      const config = loadConfig({
        NODE_ENV: "production",
        SESSION_ACCESS_TOKEN_SECRET: VALID_SESSION_SECRET,
        OTEL_SERVICE_NAME: "verixa-auth",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.com:4318",
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
        OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer secret, x-tenant=core",
        OTEL_TRACES_SAMPLER_RATE: "0.25",
      });

      expect(config.OTEL_SERVICE_NAME).toBe("verixa-auth");
      expect(config.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("https://otel.example.com:4318");
      expect(config.OTEL_EXPORTER_OTLP_PROTOCOL).toBe("http/json");
      expect(config.OTEL_EXPORTER_OTLP_HEADERS).toEqual({
        Authorization: "Bearer secret",
        "x-tenant": "core",
      });
      expect(config.OTEL_TRACES_SAMPLER_RATE).toBe(0.25);
    });

    it("treats empty OTLP endpoint and sampling rate strings as unset", () => {
      const config = loadConfig({
        NODE_ENV: "development",
        SESSION_ACCESS_TOKEN_SECRET: VALID_SESSION_SECRET,
        OTEL_EXPORTER_OTLP_ENDPOINT: "   ",
        OTEL_TRACES_SAMPLER_RATE: "",
      });

      expect(config.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
      expect(config.OTEL_TRACES_SAMPLER_RATE).toBe(1);
    });

    it("fails fast on malformed or non-HTTP OTLP endpoints", () => {
      expect(() =>
        loadConfig({
          SESSION_ACCESS_TOKEN_SECRET: VALID_SESSION_SECRET,
          OTEL_EXPORTER_OTLP_ENDPOINT: "not-a-url",
        }),
      ).toThrowError(ConfigError);

      expect(() =>
        loadConfig({
          SESSION_ACCESS_TOKEN_SECRET: VALID_SESSION_SECRET,
          OTEL_EXPORTER_OTLP_ENDPOINT: "ftp://collector.example.com:4318",
        }),
      ).toThrowError(ConfigError);
    });

    it("fails fast on unsupported OTLP protocols", () => {
      expect(() =>
        loadConfig({
          SESSION_ACCESS_TOKEN_SECRET: VALID_SESSION_SECRET,
          OTEL_EXPORTER_OTLP_PROTOCOL: "udp",
        }),
      ).toThrowError(ConfigError);
    });

    it("fails fast on malformed OTLP headers", () => {
      expect(() =>
        loadConfig({
          SESSION_ACCESS_TOKEN_SECRET: VALID_SESSION_SECRET,
          OTEL_EXPORTER_OTLP_HEADERS: "missing-equals-sign",
        }),
      ).toThrowError(ConfigError);

      expect(() =>
        loadConfig({
          SESSION_ACCESS_TOKEN_SECRET: VALID_SESSION_SECRET,
          OTEL_EXPORTER_OTLP_HEADERS: "key=",
        }),
      ).toThrowError(ConfigError);
    });

    it("fails fast on out-of-range or non-numeric sampling rates", () => {
      for (const badRate of ["-0.1", "1.5", "NaN", "always"]) {
        expect(() =>
          loadConfig({
            SESSION_ACCESS_TOKEN_SECRET: VALID_SESSION_SECRET,
            OTEL_TRACES_SAMPLER_RATE: badRate,
          }),
        ).toThrowError(ConfigError);
      }
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

  it("defaults CORS to an empty allowlist with credentials off", () => {
    // The safe default for an API: a deployment that has not thought about
    // CORS has no cross-origin browser client to break, while one that has can
    // name its origins explicitly.
    const config = loadConfig({ SESSION_ACCESS_TOKEN_SECRET: VALID_SESSION_SECRET });

    expect(config.CORS_ALLOWED_ORIGINS).toEqual([]);
    expect(config.CORS_ALLOW_CREDENTIALS).toBe(false);
  });

  it("parses a comma-separated CORS allowlist and trims whitespace", () => {
    const config = loadConfig({
      SESSION_ACCESS_TOKEN_SECRET: VALID_SESSION_SECRET,
      CORS_ALLOWED_ORIGINS: " https://app.example.com , https://admin.example.com:8443 ,",
    });

    expect(config.CORS_ALLOWED_ORIGINS).toEqual([
      "https://app.example.com",
      "https://admin.example.com:8443",
    ]);
  });

  it("accepts the wildcard origin while credentials are off", () => {
    const config = loadConfig({
      SESSION_ACCESS_TOKEN_SECRET: VALID_SESSION_SECRET,
      CORS_ALLOWED_ORIGINS: "*",
    });

    expect(config.CORS_ALLOWED_ORIGINS).toEqual(["*"]);
  });

  it("refuses the wildcard origin combined with credentialed requests", () => {
    // A browser refuses credentialed responses whose Allow-Origin is `*`, so
    // this pairing cannot do what it looks like it does. Failing at startup is
    // the only honest outcome — and the error must name both variables.
    expect(() =>
      loadConfig({
        SESSION_ACCESS_TOKEN_SECRET: VALID_SESSION_SECRET,
        CORS_ALLOWED_ORIGINS: "*",
        CORS_ALLOW_CREDENTIALS: "true",
      }),
    ).toThrowError(ConfigError);

    try {
      loadConfig({
        SESSION_ACCESS_TOKEN_SECRET: VALID_SESSION_SECRET,
        CORS_ALLOWED_ORIGINS: "*",
        CORS_ALLOW_CREDENTIALS: "true",
      });
      expect.unreachable("loadConfig should have thrown");
    } catch (error) {
      const message = (error as ConfigError).message;
      expect(message).toContain("CORS_ALLOW_CREDENTIALS");
      expect(message).toContain("*");
    }
  });

  it("rejects an allowlist entry that is not a bare origin", () => {
    // A trailing slash or a path is equivalent to a real origin to a human and
    // never equal to one on the wire, so it is exactly the misconfiguration
    // that must not reach production silently.
    for (const entry of [
      "https://app.example.com/",
      "https://app.example.com/path",
      "app.example.com",
      "ftp://app.example.com",
    ]) {
      expect(() =>
        loadConfig({
          SESSION_ACCESS_TOKEN_SECRET: VALID_SESSION_SECRET,
          CORS_ALLOWED_ORIGINS: entry,
        }),
      ).toThrowError(ConfigError);
    }
  });
});
