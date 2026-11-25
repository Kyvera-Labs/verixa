import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.config.js";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      name: "@verixa/sdk",
      coverage: {
        exclude: ["index.ts", "**/*.spec.ts"],
        thresholds: {
          statements: 85,
          lines: 85,
          functions: 80,
          branches: 80,
        },
      },
    },
  }),
);
