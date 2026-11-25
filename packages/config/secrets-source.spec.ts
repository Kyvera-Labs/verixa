import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DevSecretsSource, DotenvSecretsSource, parseDotenv } from "./secrets-source.js";

describe("parseDotenv", () => {
  it("parses standard unquoted key-value pairs", () => {
    const raw = `
PORT=3000
HOST=127.0.0.1
LOG_LEVEL=debug
`;
    expect(parseDotenv(raw)).toEqual({
      PORT: "3000",
      HOST: "127.0.0.1",
      LOG_LEVEL: "debug",
    });
  });

  it("ignores comment lines and empty lines", () => {
    const raw = `
# Server Configuration
PORT=3000

# Logging
# Another comment
LOG_LEVEL=info
`;
    expect(parseDotenv(raw)).toEqual({
      PORT: "3000",
      LOG_LEVEL: "info",
    });
  });

  it("handles 'export ' prefix on lines", () => {
    const raw = `
export DATABASE_URL=postgres://localhost:5432/db
export API_KEY=abc123xyz
`;
    expect(parseDotenv(raw)).toEqual({
      DATABASE_URL: "postgres://localhost:5432/db",
      API_KEY: "abc123xyz",
    });
  });

  it("unquotes single and double quoted values and handles escapes", () => {
    const raw = `
SINGLE_QUOTED='hello world'
DOUBLE_QUOTED="hello \\"world\\""
MULTILINE_ESCAPE="line1\\nline2"
WITH_HASH="value # not a comment"
`;
    const parsed = parseDotenv(raw);
    expect(parsed.SINGLE_QUOTED).toBe("hello world");
    expect(parsed.DOUBLE_QUOTED).toBe('hello "world"');
    expect(parsed.MULTILINE_ESCAPE).toBe("line1\nline2");
    expect(parsed.WITH_HASH).toBe("value # not a comment");
  });

  it("strips trailing comments from unquoted values", () => {
    const raw = "DB_PORT=5432 # Postgres default port";
    expect(parseDotenv(raw)).toEqual({
      DB_PORT: "5432",
    });
  });

  it("ignores malformed lines without equals sign or key", () => {
    const raw = `
THIS IS NOT A VALID LINE
=no_key
VALID_KEY=valid_value
`;
    expect(parseDotenv(raw)).toEqual({
      VALID_KEY: "valid_value",
    });
  });
});

describe("DotenvSecretsSource (Dev adapter)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "verixa-secrets-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reads secrets from a concrete .env file on disk", async () => {
    const envPath = join(tempDir, ".env");
    writeFileSync(
      envPath,
      `
SESSION_ACCESS_TOKEN_SECRET=dev-secret-key-at-least-32-chars-long
REDIS_URL=redis://localhost:6379
`,
      "utf-8",
    );

    const source = new DotenvSecretsSource({
      filePath: envPath,
      env: {},
    });

    expect(await source.getSecret("SESSION_ACCESS_TOKEN_SECRET")).toBe(
      "dev-secret-key-at-least-32-chars-long",
    );
    expect(await source.getSecret("REDIS_URL")).toBe("redis://localhost:6379");
    expect(await source.hasSecret("SESSION_ACCESS_TOKEN_SECRET")).toBe(true);
    expect(await source.hasSecret("MISSING_KEY")).toBe(false);
  });

  it("falls back to provided env or ambient process.env when file is missing", async () => {
    const source = new DotenvSecretsSource({
      filePath: join(tempDir, "does-not-exist.env"),
      env: {
        FROM_FALLBACK: "fallback-value",
      },
    });

    expect(await source.getSecret("FROM_FALLBACK")).toBe("fallback-value");
    expect(await source.hasSecret("FROM_FALLBACK")).toBe(true);
    expect(await source.getSecret("NOT_PRESENT")).toBeUndefined();
  });

  it("prioritizes file values over fallback values", async () => {
    const envPath = join(tempDir, ".env.local");
    writeFileSync(envPath, "OVERRIDDEN_KEY=file-value\n", "utf-8");

    const source = new DotenvSecretsSource({
      filePath: envPath,
      env: {
        OVERRIDDEN_KEY: "environment-value",
        OTHER_KEY: "other-value",
      },
    });

    expect(await source.getSecret("OVERRIDDEN_KEY")).toBe("file-value");
    expect(await source.getSecret("OTHER_KEY")).toBe("other-value");
  });

  it("injects into process.env when injectIntoProcessEnv is enabled", () => {
    const envPath = join(tempDir, ".env");
    const testKey = `TEST_INJECTED_VAR_${Date.now()}`;
    writeFileSync(envPath, `${testKey}=injected-value\n`, "utf-8");

    expect(process.env[testKey]).toBeUndefined();

    new DotenvSecretsSource({
      filePath: envPath,
      injectIntoProcessEnv: true,
    });

    expect(process.env[testKey]).toBe("injected-value");
    delete process.env[testKey];
  });

  it("DevSecretsSource is an alias for DotenvSecretsSource", () => {
    expect(DevSecretsSource).toBe(DotenvSecretsSource);
  });
});
