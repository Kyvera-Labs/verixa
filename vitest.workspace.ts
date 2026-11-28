import { defineWorkspace } from "vitest/config";

/**
 * Root workspace definition for Vitest.
 *
 * Discovers and coordinates test execution across all applications,
 * bounded context packages, and the integration test suite.
 */
export default defineWorkspace([
  "apps/*/vitest.config.ts",
  "packages/*/vitest.config.ts",
  "tests/vitest.config.ts",
]);
