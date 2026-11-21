import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.config.js";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      name: "@verixa/shared-kernel",
      coverage: {
        exclude: [
          ...(baseConfig.test?.coverage?.exclude ?? []),
          "**/application/ports/**",
          "index.ts",
          "**/interface/**",
        ],
        thresholds: {
          statements: 90,
          lines: 90,
          functions: 85,
          branches: 80,
        },
      },
    },
  }),
);
