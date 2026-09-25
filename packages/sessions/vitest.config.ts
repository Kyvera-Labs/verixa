import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.config.js";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      name: "@verixa/sessions",

      /**
       * The Redis integration spec starts a Testcontainers container, which
       * can take longer than vitest's default 5s hook timeout on a cold image
       * pull. The database-backed packages get away with the default because
       * CI hands them an already-running service; there is no Redis service
       * yet on every path this suite runs, so it may fall back to starting one.
       */
      hookTimeout: 120_000,
    },
  }),
);
