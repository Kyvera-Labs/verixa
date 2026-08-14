import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.config.js";

/**
 * Separate config for the live-testnet suite. It needs its own file rather
 * than a CLI filter because the default `vitest.config.ts` *excludes*
 * `*.testnet.spec.ts`, and Vitest applies `exclude` even to explicitly named
 * files — so there is no way to opt one back in from the command line alone.
 *
 * Run with `pnpm stellar:testnet`. See docs/guides/stellar-anchoring.md.
 */
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      name: "@verixa/stellar-anchor:testnet",
      include: ["**/*.testnet.spec.ts"],
      // Real network round-trips: funding an account and waiting for ledger
      // close takes far longer than any unit test should be allowed.
      testTimeout: 90_000,
      hookTimeout: 90_000,
    },
  }),
);
