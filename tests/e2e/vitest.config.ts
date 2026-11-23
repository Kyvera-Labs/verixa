import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const packageEntry = (name: string): string =>
  fileURLToPath(new URL(`../../packages/${name}/index.ts`, import.meta.url));

const packageSubpath = (name: string, entry: string): string =>
  fileURLToPath(new URL(`../../packages/${name}/${entry}.ts`, import.meta.url));

/**
 * Vitest configuration for the process-level E2E suite (Issues 414 and 517).
 *
 * The suite boots disposable Postgres and Redis containers and a compiled API
 * process, so its timeouts are sized for container startup. Failing tests are
 * retried up to twice to separate transient infrastructure blips from genuine
 * deterministic failures.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@verixa/audit/testing": packageSubpath("audit", "testing"),
      "@verixa/audit": packageEntry("audit"),
      "@verixa/stellar-anchor": packageEntry("stellar-anchor"),
    },
  },
  test: {
    name: "@verixa/e2e-tests",
    include: ["e2e/**/*.{spec,test}.ts"],
    retry: 2,
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
