// Fixture-only ESLint config (Issue 208).
//
// The repository's own config deliberately ignores this directory: these files
// are vulnerable on purpose and must never fail `pnpm lint`. This config is what
// the lint-rule fixture test points ESLint at, and it imports the *same* ruleset
// `eslint.config.mjs` uses — so an assertion that a rule fires here is an
// assertion about the gate that runs in CI, not about a copy of it.
//
// It is a separate config rather than `eslint --no-ignore` against the main one
// because the fixtures are plain JavaScript outside every tsconfig project, and
// the repository config runs type-aware linting that needs a project.

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
