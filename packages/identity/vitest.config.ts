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
        exclude: ["**/application/ports/**", "index.ts"],
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
