import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.config.js";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      name: "@verixa/governance",
      coverage: {
        // Interface-only files are erased at compile time; nothing to cover.
        exclude: ["**/application/ports/**", "index.ts"],
      },
    },
  }),
);
