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

## Cross-package imports: plain package resolution, not `paths`

One package imports another's curated public surface as `@verixa/<context>`
(e.g. `import { loadConfig } from "@verixa/config"`), but there is
deliberately **no custom `paths` mapping** for this in `tsconfig.base.json`.
It resolves through the ordinary mechanism: pnpm symlinks each workspace
package into every other package's `node_modules`, and TypeScript (like
Node at runtime) reads that package's `package.json` `main`/`types` fields —
currently `dist/index.js` / `dist/index.d.ts`.

An earlier version of this config _did_ add
`"paths": { "@verixa/*": ["packages/*/index.ts"] }` to get free cross-package
imports without a build step. It was reverted after Issue 007 hit two real
problems with it:

1. **`paths` redirects module resolution to the raw `.ts` source file**,
   which TypeScript then includes directly in the importing project's
   compilation unit. That source file lives outside the importing package's
   `rootDir`, which TypeScript rejects (`TS6059: File is not under 'rootDir'`)
   the moment a package actually imports another one.
2. Even if that were worked around, type-checking against a dependency's
   _source_ while Node loads its _built output_ at runtime is a real
   footgun: the two can silently diverge (a source-only fix that hasn't been
   built yet looks "correct" to the type checker but isn't what actually
   runs).

The upshot: a package must be built (`pnpm --filter <dependency> run build`,
or `pnpm build` for everything) before something that imports it will **run**
— Node needs the real `dist/index.js` at the `main`/`types` path, full stop.

Interestingly, `tsc --noEmit` (i.e. `typecheck`) turns out to tolerate a
missing build: when a dependency's declared `main`/`types` target doesn't
exist on disk yet, TypeScript's `NodeNext` resolution falls back to the
package root's `index.ts` (the same directory-index fallback Node itself
uses when a package's declared entry file is missing), and — because that
fallback-resolved file isn't part of the _importing_ package's own
`include`/rootDir, TypeScript type-checks it without trying to emit it, so
the rootDir violation from before doesn't recur. **Don't rely on this** — it's
an implementation detail of how missing-file resolution happens to behave,
not a documented guarantee, and it doesn't help `build` (which still needs
real declaration files to consume) or `test` (Vitest doesn't transform
`node_modules` packages, so a test importing an unbuilt dependency fails with
`ERR_MODULE_NOT_FOUND` at runtime, immediately). Always build dependencies
first regardless.

The fallback also only covers a package's main entry point (`main`/`types`
at the package root) — it does **not** apply to `package.json` `exports`
subpaths (e.g. `apps/api`'s `"./app"` export, added in Issue 015). Resolution
through `exports` is exact: if the declared file is missing, resolution
fails outright, and depending on the tool that can surface as something far
more confusing than "module not found" — ESLint's type-aware rules, for
example, silently degrade an unresolved import to `any` and then report a
cascade of unrelated-looking `no-unsafe-*` errors on every line that touches
it, which is a much harder failure to recognize as "you forgot to build a
dependency" than a clean resolution error would be.

`pnpm -r run build`/`typecheck`/`test` already do this in the right order
automatically — pnpm's recursive runner topologically sorts by workspace
dependency, so a dependency's script always runs before its dependents'
(and CI runs `build` before `typecheck`/`test` explicitly — see
`docs/guides/ci-cd.md`). The root `dev` script does the same explicitly
(`pnpm --filter @verixa/api^... run build`, i.e. "build api's dependencies,
but not api itself" — api runs via `tsx`, which doesn't need a build step for
its own code) before starting the watcher.

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
