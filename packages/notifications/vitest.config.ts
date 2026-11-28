import { fileURLToPath } from "node:url";

import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.config.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

// Coverage thresholds and the curated public surface for this package are
// still to be done; until then it runs on the shared base config.
export default mergeConfig(
  baseConfig,
  defineConfig({
    // The notification-sender contract spec imports @verixa/testing-kit's
    // index (deep imports are now forbidden), which re-exports fakes from most
    // workspace packages. Resolve those to source exactly as
    // packages/testing-kit/vitest.config.ts does, so the spec does not depend
    // on every package's built `dist` being resolvable.
    resolve: {
      alias: {
        "@verixa/shared-kernel": `${repoRoot}packages/shared-kernel/index.ts`,
        "@verixa/identity": `${repoRoot}packages/identity/index.ts`,
        "@verixa/sessions": `${repoRoot}packages/sessions/index.ts`,
        "@verixa/credentials": `${repoRoot}packages/credentials/index.ts`,
        "@verixa/mfa": `${repoRoot}packages/mfa/index.ts`,
        "@verixa/authorization": `${repoRoot}packages/authorization/index.ts`,
        "@verixa/audit": `${repoRoot}packages/audit/index.ts`,
        "@verixa/verification": `${repoRoot}packages/verification/index.ts`,
        "@verixa/stellar-anchor": `${repoRoot}packages/stellar-anchor/dist/index.js`,
      },
    },
    test: {
      name: "@verixa/notifications",
      coverage: {
        exclude: ["index.ts", "src/server.ts"],
        thresholds: {
          statements: 85,
          lines: 85,
          functions: 80,
          branches: 75,
        },
      },
    },
  }),
);
