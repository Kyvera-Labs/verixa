import { defineConfig } from "vitest/config";

/**
 * Shared base config every package's vitest.config.ts merges into its own.
 * Not run directly against the whole monorepo in one process — each package
 * still runs its own `vitest run` (see package.json "test" scripts) so a
 * package's tests execute with that package's own node_modules and working
 * directory, which matters once cross-package imports (Issue 007) are
 * involved.
 */
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "coverage",
      exclude: ["**/dist/**", "**/*.spec.ts", "**/vitest.config.ts", "**/eslint.config.mjs"],
    },
  },
});
