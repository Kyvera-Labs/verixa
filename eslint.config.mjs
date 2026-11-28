// @ts-check
import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript";
import importPlugin from "eslint-plugin-import-x";
import tseslint from "typescript-eslint";

import { securityPlugin, securityRules } from "./infra/ci/security-lint-rules.mjs";

/**
 * `@verixa/testing-kit` is consumed only through its curated root,
 * the same boundary the context packages keep. Declared once
 * because two config blocks below need it, and a flat-config block setting
 * `no-restricted-imports` replaces, rather than merges with, another block's
 * options for the same file. Verified by packages/testing-kit/index.spec.ts.
 */
const TESTING_KIT_BOUNDARY = {
  group: ["@verixa/testing-kit/*"],
  message:
    "Import from `@verixa/testing-kit`, not a deep path — only what its index.ts exports is public, and each export is documented in docs/guides/tutorials/testing-the-platform.md.",
};

export default tseslint.config(
  {
    // scripts/** holds standalone Node scripts that aren't part of any
    // workspace package's tsconfig project (see docs/guides/database.md) —
    // type-aware linting needs a project to check against, which these
    // deliberately don't have.
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      "**/*.config.*",
      "vitest.workspace.*",
      "planning/**",
      "scripts/**",
      // Same reason as scripts/**, and the same trade-off. This one is not even
      // a candidate for a tsconfig project: the lockfile gate has to run before
      // `pnpm install`, so it declares no dependencies and no loader, which
      // leaves it plain JavaScript outside any package's build. Its sibling
      // generate-sbom.ts is TypeScript and *is* covered, via infra/ci/tsconfig.json
      // (typechecked by `pnpm typecheck:ci`).
      "infra/ci/**/*.mjs",
      // Standalone compose backup/restore CLIs: same reason as scripts/** and
      // infra/ci/**/*.mjs — they are run with plain `node`, outside any
      // workspace tsconfig, so project-service linting has no project to use.
      "infra/docker/scripts/**/*.mjs",
      "tests/**/*.mjs",
      // Not built: written against a `webauthn_credentials` table that was
      // never migrated. See the header comment on
      // prisma-webauthn-credential-repository.ts.
      "packages/mfa/infrastructure/persistence/prisma-webauthn-credential-repository.ts",
      "packages/mfa/infrastructure/persistence/prisma-webauthn-credential-repository.spec.ts",
      "packages/mfa/infrastructure/persistence/webauthn-credential-mapper.ts",
      // Deliberately vulnerable snippets for the security lint rules (Issue
      // 208). They exist to be *caught* by the fixture tests, so linting them
      // as repository code would make `pnpm lint` fail on purpose-built
      // examples of the vulnerabilities the gate is meant to prevent.
      "infra/ci/lint-security-fixtures/**",
      // VitePress build output and its pre-bundled dependency cache (Issue
      // 422). Generated, gitignored, and large; docs/.vitepress/config.ts
      // itself is linted, via docs/.vitepress/tsconfig.json.
      "docs/.vitepress/cache/**",
      "docs/.vitepress/dist/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    // The security ruleset lives in `infra/ci/security-lint-rules.mjs` so the
    // fixture tests in `tests/ci/security-lint.spec.ts` lint the same rules
    // this config enables, rather than a re-declared copy.
    plugins: { security: securityPlugin },
    rules: securityRules,
  },
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
    // ("Package encapsulation"). Scoped to exclude packages/identity and
    // packages/credentials themselves, since their own internal files
    // legitimately import each other by relative path; this rule targets
    // deep imports from *other* packages.
    files: ["**/*.ts"],
    ignores: [
      // A context package's own files legitimately reach their own internals.
      "packages/identity/**",
      "packages/credentials/**",
      "packages/mfa/**",
      "packages/sessions/**",
      "packages/audit/**",
      "packages/authorization/**",
      "packages/verification/**",
      "packages/observability/**",
      "packages/testing-kit/**",
      // The integration suite deliberately exercises internals -- forging a
      // forked chain entry to prove the repository refuses it, for one. That
      // is the opposite of a production package quietly depending on them,
      // which is what this rule exists to stop.
      "tests/**",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@verixa/audit/*",
                "@verixa/authorization/*",
                "@verixa/credentials/*",
                "@verixa/identity/*",
                "@verixa/mfa/*",
                "@verixa/sessions/*",
                "@verixa/verification/*",
                "@verixa/observability/*",
              ],
              message:
                "Import from the package root (`@verixa/identity`, `@verixa/credentials`, `@verixa/mfa`, `@verixa/sessions`, `@verixa/audit`, `@verixa/authorization`, `@verixa/verification`, `@verixa/observability`), not a deep path — a context's domain/application internals are not part of its public API. See docs/guides/domain-modeling.md.",
            },
            TESTING_KIT_BOUNDARY,
          ],
        },
      ],
    },
  },
  {
    // The integration suite is exempt from the block above so it can reach
    // *context* internals on purpose. That reason does not extend to
    // testing-kit, whose internals hold nothing a test needs to forge, and
    // tests/examples/ consumes it. No other block sets
    // `no-restricted-imports` for tests/**, so this one overrides nothing.
    files: ["tests/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [TESTING_KIT_BOUNDARY] }],
    },
  },
  {
    // Layering: domain and application code must not import infrastructure, or they can no longer
    // be tested without a database or reused outside HTTP. When this fires, define a port in
    // `application/ports/` and let the composition root supply the adapter (see
    // docs/guides/domain-modeling.md).
    files: ["packages/*/domain/**/*.ts", "packages/*/application/**/*.ts"],
    ignores: ["**/*.spec.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/infrastructure/**",
                "@prisma/client",
                "@verixa/database",
                "fastify",
                "@stellar/stellar-sdk",
              ],
              message:
                "Domain and application layers must not import infrastructure. Define a port in `application/ports/` and wire the concrete implementation in the composition root instead. See docs/guides/domain-modeling.md.",
            },
          ],
        },
      ],
    },
  },
  {
    // Test scaffolding and the CI tooling in `infra/ci` write to paths that
    // are only known at runtime — a temporary directory from `mkdtempSync`, a
    // path the workflow passed as an argument. Neither is shipped to a
    // deployment, and there is no untrusted caller choosing the path. That is
    // the rule working as intended on code that is not the attack surface it
    // targets, so it stays visible as a warning instead of failing a correct
    // build.
    // The docs site config is the same case: it reads docs/ at
    // build time to list sidebar pages, and never runs in a deployment.
    files: ["tests/**/*.ts", "**/*.spec.ts", "infra/ci/**/*.ts", "docs/.vitepress/config.ts"],
    rules: {
      "security/detect-non-literal-fs-filename": "warn",
    },
  },
  {
    // Injection hardening (docs/security/injection-hardening.md): flags Prisma's unsafe raw-query
    // escape hatches, such as `$queryRawUnsafe` or any raw call given a built string. The
    // tagged-template form (`prisma.$executeRaw` with `${value}` inside the template) is safe,
    // because Prisma binds the values; those are `TaggedTemplateExpression` nodes, which these
    // selectors do not match.
    files: ["**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            'CallExpression[callee.property.name=/^\\$(query|execute)Raw(Unsafe)?$/] :matches(TemplateLiteral, BinaryExpression[operator="+"])',
          message:
            "Raw SQL must be built with placeholders, not string concatenation or an interpolated template literal. Use the tagged-template form (prisma.$executeRaw`... ${value} ...`), which binds `value`; or pass a literal statement plus bound parameters. A justified exception must say why in a disable comment. See docs/security/injection-hardening.md.",
        },
        {
          selector:
            'CallExpression[callee.name=/^(exec|execSync)$/] :matches(TemplateLiteral, BinaryExpression[operator="+"])',
          message:
            "Do not build a shell command by concatenation or interpolation. Call `execFileSync`/`spawnSync` with an argument array instead, which never reaches a shell. See docs/security/injection-hardening.md.",
        },
      ],
    },
  },
  {
    // The same concern, one step stricter for code that ships. Test suites may
    // need DDL (`CREATE ROLE`, `GRANT`) that Postgres cannot bind — those sites
    // carry a disable comment and are listed in docs/security/injection-hardening.md.
    // Production code has no such need: every statement it runs can be
    // parameterized, so the unsafe functions are simply absent.
    files: [
      "apps/**/*.ts",
      "packages/*/domain/**/*.ts",
      "packages/*/application/**/*.ts",
      "packages/*/infrastructure/**/*.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.property.name=/^\\$(query|execute)RawUnsafe$/]",
          message:
            "`$queryRawUnsafe`/`$executeRawUnsafe` take a runtime-built string and cannot bind parameters. Use the tagged-template prisma.$queryRaw`...` form. See docs/security/injection-hardening.md.",
        },
        {
          selector:
            'CallExpression[callee.name=/^(exec|execSync|eval)$/] , NewExpression[callee.name="Function"]',
          message:
            "Shell execution and dynamic evaluation are not permitted in shipped code. Use `execFileSync` with an argument array, and replace `eval`/`new Function` with code that does not need to generate itself. See docs/security/injection-hardening.md.",
        },
      ],
    },
  },
  eslintConfigPrettier,
);
