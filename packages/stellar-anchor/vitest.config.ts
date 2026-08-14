import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.config.js";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      name: "@verixa/stellar-anchor",
      // The Stellar testnet suite is excluded from the default run: it needs
      // network access and a friendbot-funded account, so it is neither fast
      // nor hermetic. Run it explicitly with `pnpm stellar:testnet` — see
      // docs/guides/stellar-anchoring.md.
      exclude: ["**/node_modules/**", "**/dist/**", "**/*.testnet.spec.ts"],
    },
  }),
);
