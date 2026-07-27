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
  eslintConfigPrettier,
);
