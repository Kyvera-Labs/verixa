import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@verixa/governance",
    include: ["**/*.spec.ts"],
  },
});
