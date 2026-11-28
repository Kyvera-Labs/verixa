import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const repoRoot = fileURLToPath(new URL(".", import.meta.url));

/**
 * Shared base config every package's vitest.config.ts merges into its own.
 * Not run directly against the whole monorepo in one process — each package
 * still runs its own `vitest run` (see package.json "test" scripts) so a
 * package's tests execute with that package's own node_modules and working
 * directory, which matters once cross-package imports (Issue 007) are
 * involved.
 */
export default defineConfig({
  resolve: {
    alias: {
      // `@stellar/stellar-sdk`'s peer dependencies make pnpm install `@verixa/stellar-anchor` as a
      // `file:` copy for some consumers, and that copy omits the gitignored `dist/`. Aliasing
      // straight to the build output avoids that resolution.
      "@verixa/stellar-anchor": `${repoRoot}packages/stellar-anchor/dist/index.js`,
    },
  },
  test: {
    // Vitest 4 narrowed the default exclude to node_modules and .git, so the
    // compiled `*.spec.js` copies that `pnpm build` writes to dist/ would run
    // as a second, stale set of tests. Keep only the sources.
    exclude: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/coverage/**"],

    /**
     * Child processes, not worker threads (Issue 415). This is Vitest's
     * default, stated here so it reads as a decision. Several packages load
     * native code in tests (Prisma's query engine, the argon2 addon), which is
     * safer with a process per worker, and a crash in one is contained to
     * that worker instead of the whole run. `threads` starts faster, but that
     * was reasoned about, not measured.
     */
    pool: "forks",

    /**
     * Half the cores per package rather than Vitest's default. `pnpm test` runs up to four packages
     * at once, each with its own pool, and the default oversubscribed the machine, slowing runs and
     * causing timeouts. A percentage so larger machines still get more workers (figures in
     * docs/guides/testing/performance-budget.md).
     */
    maxWorkers: "50%",
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "coverage",
      exclude: ["**/dist/**", "**/*.spec.ts", "**/vitest.config.ts", "**/eslint.config.mjs"],
    },
  },
});
