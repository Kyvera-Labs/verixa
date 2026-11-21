import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.config.js";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      name: "@verixa/observability",
      fileParallelism: false,
      coverage: {
        // The same gate established across prior phases (Issue 037 pattern).
        // Measures tested executable statements while excluding interface definitions.
        exclude: [
          // Interface-only declarations have no runtime executable code.
          "**/application/ports/**",
          "index.ts",
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
