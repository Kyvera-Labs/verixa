import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.config.js";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      name: "@verixa/sessions",
      coverage: {
        exclude: [
          "**/application/ports/**",
          "index.ts",
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
