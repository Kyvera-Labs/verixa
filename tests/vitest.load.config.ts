import { defineConfig, mergeConfig } from "vitest/config";

import config from "./vitest.config.js";

/**
 * Config for the audit write-path load test, run with `pnpm test:load`. A separate file because the
 * default config excludes these specs and Vitest applies `exclude` even to files named on the
 * command line. Kept out of CI because the numbers are machine-specific (see
 * docs/performance/baseline.md). Files are named `*.load.ts` so the default include pattern never
 * matches them.
 */
export default mergeConfig(
  config,
  defineConfig({
    test: {
      name: "@verixa/integration-tests:load",
      include: ["load/**/*.load.ts"],
      // Thousands of real inserts, plus warm-up runs.
      testTimeout: 180_000,
      hookTimeout: 180_000,
      // One database, and the suites truncate the audit table between runs.
      fileParallelism: false,
    },
  }),
);
