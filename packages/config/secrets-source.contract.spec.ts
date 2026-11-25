import { describe, expect, it } from "vitest";

import {
  DotenvSecretsSource,
  InMemorySecretsSource,
  type SecretsSource,
} from "./secrets-source.js";

/**
 * Shared contract test suite for any implementation of SecretsSource (Issue 391 / #503).
 */
export function describeSecretsSourceContract(
  name: string,
  factory: (initial: Record<string, string>) => SecretsSource | Promise<SecretsSource>,
): void {
  describe(`SecretsSource Contract: ${name}`, () => {
    it("reports a non-empty provider name", async () => {
      const source = await factory({});
      expect(typeof source.name).toBe("string");
      expect(source.name.trim().length).toBeGreaterThan(0);
    });

    it("retrieves an existing secret value by key", async () => {
      const source = await factory({
        SESSION_SECRET: "test-secret-value-12345",
        DATABASE_URL: "postgres://localhost:5432/test",
      });

      expect(await source.getSecret("SESSION_SECRET")).toBe("test-secret-value-12345");
      expect(await source.getSecret("DATABASE_URL")).toBe("postgres://localhost:5432/test");
    });

    it("returns undefined for an unknown key", async () => {
      const source = await factory({ EXISTING_KEY: "value" });
      expect(await source.getSecret("NON_EXISTENT_KEY")).toBeUndefined();
    });

    it("correctly identifies existing vs missing keys via hasSecret", async () => {
      const source = await factory({ ACTIVE_KEY: "true" });

      expect(await source.hasSecret("ACTIVE_KEY")).toBe(true);
      expect(await source.hasSecret("MISSING_KEY")).toBe(false);
    });

    it("returns all secrets when getSecrets is invoked with no arguments", async () => {
      const initial = {
        KEY_A: "val_a",
        KEY_B: "val_b",
        KEY_C: "val_c",
      };
      const source = await factory(initial);

      const all = await source.getSecrets();
      expect(all).toEqual(expect.objectContaining(initial));
    });

    it("returns only requested keys when getSecrets is invoked with specific keys", async () => {
      const source = await factory({
        KEY_A: "val_a",
        KEY_B: "val_b",
        KEY_C: "val_c",
      });

      const filtered = await source.getSecrets(["KEY_A", "KEY_C", "NON_EXISTENT"]);
      expect(filtered).toEqual({
        KEY_A: "val_a",
        KEY_C: "val_c",
      });
      expect(filtered).not.toHaveProperty("KEY_B");
      expect(filtered).not.toHaveProperty("NON_EXISTENT");
    });
  });
}

// Execute contract against InMemorySecretsSource
describeSecretsSourceContract("InMemorySecretsSource", (initial) => {
  return new InMemorySecretsSource(initial);
});

// Execute contract against DotenvSecretsSource (dev adapter)
describeSecretsSourceContract("DotenvSecretsSource", (initial) => {
  return new DotenvSecretsSource({
    filePath: "/non/existent/path/.env.test",
    env: initial,
  });
});
