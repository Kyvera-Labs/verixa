import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "./index.js";

describe("loadConfig", () => {
  it("produces a typed config object from a fully-specified environment", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      PORT: "8080",
      HOST: "127.0.0.1",
      LOG_LEVEL: "warn",
      DATABASE_URL: "postgres://user:pass@db.example.com:5432/verixa",
    });

    expect(config).toEqual({
      NODE_ENV: "production",
      PORT: 8080,
      HOST: "127.0.0.1",
      LOG_LEVEL: "warn",
      DATABASE_URL: "postgres://user:pass@db.example.com:5432/verixa",
    });
  });

  it("coerces PORT from a string to a number", () => {
    const config = loadConfig({ PORT: "4000" });

    expect(config.PORT).toBe(4000);
    expect(typeof config.PORT).toBe("number");
  });

  it("applies defaults when optional variables are missing", () => {
    const config = loadConfig({});

    expect(config).toEqual({
      NODE_ENV: "development",
      PORT: 3000,
      HOST: "0.0.0.0",
      LOG_LEVEL: "info",
      DATABASE_URL: "postgres://verixa:verixa@localhost:5432/verixa",
    });
  });

  it("returns an immutable object", () => {
    const config = loadConfig({});

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
    expect(() => loadConfig({ PORT: "70000" })).toThrowError(ConfigError);
  });

  it("rejects a malformed DATABASE_URL", () => {
    expect(() => loadConfig({ DATABASE_URL: "not-a-url" })).toThrowError(ConfigError);
  });
});
