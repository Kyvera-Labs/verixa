import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../vitest.config.js";

const packageEntry = (name: string): string =>
  fileURLToPath(new URL(`../packages/${name}/index.ts`, import.meta.url));

/** A named entry point of a workspace package, resolved to its source. */
const packageSubpath = (name: string, entry: string): string =>
  fileURLToPath(new URL(`../packages/${name}/${entry}.ts`, import.meta.url));

export default mergeConfig(
  baseConfig,
  defineConfig({
    /**
     * Resolves two workspace packages to source rather than build output. `injectWorkspacePackages`
     * (needed for `pnpm deploy`) makes pnpm copy `@verixa/audit` and `@verixa/stellar-anchor` into
     * dependents during install, before any `dist` exists, so on a clean checkout they failed to
     * resolve. These specs test behaviour, not packaging; the Docker job proves the built packages
     * resolve.
     */
    resolve: {
      alias: {
        // Listed before the bare specifier: Vite matches aliases in order, and
        // a `@verixa/audit` entry would otherwise swallow the subpath and then
        // fail to resolve `/testing` against a file path.
        "@verixa/audit/testing": packageSubpath("audit", "testing"),
        "@verixa/audit": packageEntry("audit"),
        "@verixa/stellar-anchor": packageEntry("stellar-anchor"),
      },
    },
    test: {
      name: "@verixa/integration-tests",

      // One `exclude`, not two: a second key in this object silently replaced
      // the first, so after #611 the e2e specs ran in this suite too.
      // - e2e/**: the end-to-end suite has its own config (`pnpm test:e2e`).
      // - ci/**: the CI-tooling specs run under `vitest.ci.config.ts` instead,
      //   with file parallelism: they touch no database, so the serial rule
      //   below does not apply to them (Issue 415).
      exclude: [...configDefaults.exclude, "**/dist/**", "e2e/**", "ci/**"],

      /**
       * Spec files run one at a time: they share a single Postgres database, and several assert on
       * whole-table state or clear tables between tests, so concurrent files interfere. Running
       * them in parallel would need a database per worker.
       */
      fileParallelism: false,
    },
  }),
);
