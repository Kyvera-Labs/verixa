import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../vitest.config.js";

/**
 * The CI-tooling specs (`ci/**`), run with file parallelism (Issue 415).
 *
 * They live in this package but share nothing with the database-backed
 * specs: each one builds its fixture in its own `mkdtemp` directory, spawns
 * the tool under test against it, and only *reads* the real repository. So
 * the reason `vitest.config.ts` runs files one at a time, a single shared
 * Postgres, does not apply to them. Run serially, they were about half of
 * this package's wall-clock time with no database involved at all.
 *
 * A separate config rather than a Vitest project inside `vitest.config.ts`:
 * `fileParallelism` is a run-wide option in Vitest 3 (it is in
 * `NonProjectOptions`), so one run cannot mix serial and parallel files.
 *
 * Merges the repository base directly, not `vitest.config.ts`: these specs
 * import no workspace package, so they need none of its aliases, and
 * inheriting its `exclude` of `ci/**` would exclude everything here.
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
