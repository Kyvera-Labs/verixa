import { defineConfig, mergeConfig } from "vitest/config";

import identityConfig from "./vitest.config.js";

/**
 * The test run Stryker uses for mutation testing (.github/workflows/mutation-testing.yml).
 *
 * Same as the package config, minus the Prisma suites: they need a real
 * Postgres and spawn `pnpm` to apply migrations, which does not exist inside
 * Stryker's sandbox, so the initial dry run failed before any mutant ran.
 * They exercise the database adapters, which stryker.conf.json does not
 * mutate anyway; the domain and use-case tests that kill mutants all stay.
 */
export default mergeConfig(
  identityConfig,
  defineConfig({
    test: {
      exclude: [
        "**/node_modules/**",
        "**/dist/**",
        "infrastructure/persistence/prisma-repositories.spec.ts",
        "infrastructure/persistence/prisma-tenant-context.spec.ts",
      ],
    },
  }),
);
