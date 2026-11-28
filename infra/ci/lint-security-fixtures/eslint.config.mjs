// ESLint config for the deliberately vulnerable security-rule fixtures, which the main config
// ignores. It imports the same ruleset as `eslint.config.mjs`, so fixture tests check the real CI
// rules. A separate config because the fixtures are plain JavaScript outside every tsconfig
// project, and the main config lints with type information.

import { securityPlugin, securityRules } from "../security-lint-rules.mjs";

export default [
  {
    files: ["**/*.js", "**/*.cjs", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        Buffer: "readonly",
        module: "readonly",
        process: "readonly",
        require: "readonly",
      },
    },
    plugins: { security: securityPlugin },
    rules: securityRules,
  },
];
