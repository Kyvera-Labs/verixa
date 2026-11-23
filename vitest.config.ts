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
      // @stellar/stellar-sdk pulls in debug/supports-color through a chain
      // that gives @verixa/stellar-anchor a peer-dependency signature, which
      // makes pnpm materialize it as a content-filtered `file:` copy for
      // some consumers (apps/api) instead of a plain workspace symlink
      // (packages/audit gets the symlink and never hits this). A `file:`
      // copy only contains git-tracked files, so the gitignored `dist/`
      // output built by `pnpm build` is silently missing from it, and
      // Vite's stricter entry resolution in v6 fails rather than guessing.
      // Aliasing straight to the real build output sidesteps node_modules
      // resolution for this one package entirely.
      "@verixa/stellar-anchor": `${repoRoot}packages/stellar-anchor/dist/index.js`,
    },
  },
  test: {
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
     * Half the cores per package, not Vitest's default of all cores but one.
     *
     * `pnpm test` runs up to four packages at once (`pnpm -r`), and each
     * package's Vitest starts its own pool. At the default that was up to
     * twelve forks on a four-thread machine, which made the run slower and
     * flaky: a guard test in `@verixa/authorization` timed out at 5s under
     * the contention. At 50%, the unit suite went from 296.7s/216.5s to
     * 222.6s/150.6s over two runs each, and the timeout went away. Figures
     * and method: docs/guides/testing/performance-budget.md.
     *
     * A percentage rather than a fixed count, so a larger machine still gets
     * more workers. A cap of 1 per package was considered and not measured.
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
