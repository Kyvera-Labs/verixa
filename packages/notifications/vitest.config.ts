import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.config.js";

// Coverage thresholds and the curated public surface for this package are
// Issue 279's deliverable; until then it runs on the shared base config.
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      name: "@verixa/notifications",
    },
  }),
);
