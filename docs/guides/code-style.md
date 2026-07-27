# Code Style

Verixa uses ESLint (flat config) and Prettier to keep the codebase consistent
and to catch real bugs, not just style nits.

## Commands

```bash
pnpm lint           # lint the whole workspace
pnpm format         # auto-fix formatting with Prettier
pnpm format:check   # check formatting without writing (used in CI)
```

## Configuration

- **`eslint.config.mjs`** (repo root) is a single flat config that applies to
  every package in the monorepo — there is no per-package ESLint config to
  keep in sync. It combines:
  - `@eslint/js` recommended rules
  - `typescript-eslint`'s type-checked recommended rules (uses
    `parserOptions.projectService`, so each linted file is checked against its
    nearest `tsconfig.json` automatically)
  - `eslint-plugin-import-x` for import correctness and a consistent,
    alphabetized import order with blank lines between groups
  - `eslint-plugin-security` for common Node.js security footguns (e.g.
    non-literal `RegExp`, unsafe `child_process` usage)
  - `eslint-config-prettier` last, to disable any ESLint formatting rules that
    would conflict with Prettier
- **`.prettierrc.json`** / **`.prettierignore`** configure formatting itself.
  Prettier owns formatting; ESLint owns correctness. Don't add formatting
  rules to the ESLint config — that's what `eslint-config-prettier` prevents.

## Why linting catches bugs, not just style

Style rules (quotes, semicolons, indentation) are the least interesting part
of a linter. The rules that matter catch real defects:

- **`@typescript-eslint/no-floating-promises`** — flags a promise that's
  neither `await`ed, `return`ed, nor explicitly discarded. This is exactly the
  bug shape behind "why did this write silently not happen" incidents: an
  `async` call inside a non-async function gets fired and forgotten, and any
  rejection becomes an unhandled promise rejection instead of a visible error.
- **`@typescript-eslint/no-explicit-any`** — `any` doesn't just weaken types
  locally, it silently disables type checking for everything that value flows
  into, often far from where the `any` was introduced.
- **`eslint-plugin-security`** rules — things like `detect-non-literal-fs-filename`
  or `detect-child-process` flag patterns that are _usually_ fine but are also
  exactly how path traversal and command injection vulnerabilities happen.
  They're worth a second look, not a blanket disable.

## Pre-commit / CI

Local pre-commit enforcement (Husky + lint-staged) and the CI lint job land in
later issues (009, 011) and will run these same two commands — nothing
CI-specific is introduced there.
