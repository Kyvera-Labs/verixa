import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../vitest.config.js";

/**
 * Runs the CI-tooling specs (`ci/**`) with file parallelism. They use their own temporary
 * directories and only read the repository, so the serial rule for the shared database does not
 * apply. A separate config because `fileParallelism` is a run-wide option. Merges the root base
 * config directly, since `vitest.config.ts` excludes `ci/**` and adds unneeded aliases.
 */
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      name: "@verixa/integration-tests:ci",
      include: ["ci/**/*.spec.ts"],
    },
  }),
);
