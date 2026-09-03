import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.config.js";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      name: "@verixa/identity",
      coverage: {
        // Interface-only files have no executable statements to cover — a
        // TypeScript `interface` is erased entirely at compile time, so
        // there's nothing a test could ever exercise. Including them would
        // either drag the ratio down for no real signal or (as observed)
        // report a meaningless 0% for a file with zero total statements.
        exclude: [
          "**/application/ports/**",
          "index.ts",
          // Database adapters are covered by the contract suite in
          // prisma-repositories.spec.ts, which runs only where a real
          // Postgres is available. Counting them here would mean the gate
          // measures "was a database present" rather than "is this code
          // tested" — it would fail on a developer machine without Docker
          // while passing in CI, for the same commit. The coverage that
          // matters for these files is enforced by the contract suite
          // itself, which CI requires via REQUIRE_DATABASE_TESTS=1.
          "**/infrastructure/persistence/**",
          "**/infrastructure/testing/database-harness.ts",
        ],
        thresholds: {
          statements: 90,
          lines: 90,
          functions: 85,
          branches: 85,
        },
      },
    },
  }),
);
