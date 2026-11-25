import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.config.js";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      name: "@verixa/authorization",
      fileParallelism: false,
      coverage: {
        // Interface-only files have no executable statements to cover — see
        // packages/identity/vitest.config.ts for the fuller rationale.
        // Ports are interface-only files: a TypeScript `interface` is erased at
        // compile time, so there is no executable statement a test could cover.
        // Counting them would report a meaningless 0% for a file with zero
        // total statements, the same reasoning @verixa/identity documents.
        exclude: [
          "**/application/ports/**",
          "index.ts",
          "**/infrastructure/testing/**",
          "**/infrastructure/seed/**",
        ],
        thresholds: {
          statements: 88,
          lines: 88,
          functions: 90,
          branches: 89,
        },
      },
    },
  }),
);
