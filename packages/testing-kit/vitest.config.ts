import { fileURLToPath } from "node:url";

import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.config.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

export default mergeConfig(
  baseConfig,
  defineConfig({
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
      name: "@verixa/testing-kit",
      coverage: {
        exclude: [
          "index.ts",
          "**/fakes/index.ts",
          "**/factories/index.ts",
          "**/fakes/fake-contract.ts",
        ],
        thresholds: {
          statements: 85,
          lines: 85,
          functions: 85,
          branches: 70,
        },
      },
    },
  }),
);
