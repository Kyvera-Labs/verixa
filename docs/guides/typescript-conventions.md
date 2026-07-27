# TypeScript Conventions

Every package extends the root `tsconfig.base.json`, which turns on strict
type checking from day one. Retrofitting strictness onto a large codebase
later is expensive and always incomplete — flags get turned on, existing
violations get silenced with `// @ts-ignore` instead of fixed, and the
guarantee quietly stops meaning anything. Verixa starts strict and stays
strict.

## What each flag catches

- **`strict: true`** — the umbrella flag (enables `strictNullChecks`,
  `noImplicitAny`, `strictFunctionTypes`, and friends). Without
  `strictNullChecks`, `null`/`undefined` are assignable to everything, and
  `user.email.toLowerCase()` compiles even when `user.email` might not exist.
  That's a runtime `TypeError` in production that the compiler could have
  caught for free.

- **`noUncheckedIndexedAccess`** — without it, `arr[i]` has type `T`, not
  `T | undefined`, even though a plain array/object index access can always
  be out of bounds or missing. Example:

  ```ts
  function firstPositive(nums: number[]): number {
    const x: number = nums[0]; // compiles without this flag, even for []
    return x > 0 ? x : 0;
  }
  ```

  With `noUncheckedIndexedAccess` on, `nums[0]` is `number | undefined`, and
  the assignment above fails to compile — forcing you to handle the empty-
  array case explicitly instead of discovering it via a production crash.

- **`exactOptionalPropertyTypes`** — without it, `{ name?: string }` treats
  `{ name: undefined }` as equivalent to omitting `name` entirely, which masks
  bugs where a caller passes `undefined` on purpose vs. by mistake (e.g. a
  form field that was never touched vs. one explicitly cleared).

- **`noImplicitOverride`** — requires the `override` keyword on methods that
  override a base class method, so renaming a base method doesn't silently
  turn a subclass's override into an unrelated new method.

- **`isolatedModules`** — ensures every file can be transpiled independently
  (required by esbuild/SWC-based tooling like `tsx` and Vitest), catching
  patterns (like re-exporting a `const enum`) that only work with full
  program knowledge.

## Path aliases

`tsconfig.base.json` declares `@verixa/*` → `packages/*/index.ts`, so once a
bounded-context package exists under `packages/<context>/`, other packages
import its curated public surface as `@verixa/<context>` rather than a
relative path reaching across the monorepo. This also gives the
deep-import-prevention ESLint rule (introduced in Phase 02) a clean pattern to
enforce against.

## Per-package configuration

Each package's `tsconfig.json` extends the root config and only overrides
`rootDir`/`outDir`/`include`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

Note that relative paths inside `paths` in the base config resolve relative
to the base config's own directory (the repo root), not the extending
package's directory — this is what lets one `paths` map work for every
package without duplication.
