// @ts-check
import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript";
import importPlugin from "eslint-plugin-import-x";
import security from "eslint-plugin-security";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/coverage/**", "**/node_modules/**", "**/*.config.*", "planning/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  security.configs.recommended,
  importPlugin.flatConfigs.recommended,
  importPlugin.flatConfigs.typescript,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    settings: {
      "import-x/resolver-next": [createTypeScriptImportResolver()],
    },
    rules: {
      // Async bugs (unhandled rejections) are a common real-world production
      // failure mode; this rule requires promises to be awaited, returned, or
      // explicitly voided.
      "@typescript-eslint/no-floating-promises": "error",
      "import-x/order": [
        "error",
        {
          "newlines-between": "always",
          alphabetize: { order: "asc", caseInsensitive: true },
        },
      ],
      // TypeScript's own resolution already catches unresolved imports.
      "import-x/no-unresolved": "off",
    },
  },
  {
    // Package boundary enforcement: everything outside a context package
    // must go through its curated index.ts, never a deep path into its
    // domain/application internals — see docs/guides/domain-modeling.md
    // ("Package encapsulation"). Scoped to exclude packages/identity itself,
    // since its own internal files legitimately import each other by
    // relative path; this rule targets deep imports from *other* packages.
    files: ["**/*.ts"],
    ignores: ["packages/identity/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@verixa/identity/*"],
              message:
                "Import from the package root (`@verixa/identity`), not a deep path — its domain/application internals are not part of the public API. See docs/guides/domain-modeling.md.",
            },
          ],
        },
      ],
    },
  },
  eslintConfigPrettier,
);
