import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.config.js";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      name: "@verixa/database",
      coverage: {
        exclude: [...(baseConfig.test?.coverage?.exclude ?? []), "prisma/seed.ts", "scripts/**"],
      },
    },
  }),
);
