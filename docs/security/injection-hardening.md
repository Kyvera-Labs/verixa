# Injection Hardening

Prisma parameterizes by default. That sentence is true often enough to be
relied on and not often enough to be trusted, because every ORM ships escape
hatches around its own builder — and an escape hatch that is convenient, silent
and one keystroke away from a safe call is where injection classes come back.
This document is the record of the review that checked that claim across the
codebase, the pattern contributors are expected to follow, and the lint rule
that stops the next change from quietly undoing it.

What is here because of Issue 210. What is _not_ here: any change to how RLS
works ([multi-tenancy.md](./multi-tenancy.md)), which remains the actual
tenant-isolation boundary; injection is how an attacker gets to the query, RLS
is what limits what a query can reach.

## The pattern

**Bind. Never build.** The safe form of a raw query is Prisma's tagged
template, which is a _call-shaped syntax that is not a function call_:

```ts
// Safe. The interpolations become $1, $2 placeholders and travel separately.
await tx.$executeRaw`SELECT set_config(${TENANT_CONTEXT_SETTING}, ${organizationId}, true)`;
```

```ts
// Not safe. One string, built by whoever wrote it, sent as-is.
await tx.$executeRawUnsafe(`SELECT set_config('app.x', '${organizationId}', true)`);
```

The two look almost identical, and the difference is whether the value is
_inside the statement text_ or _beside it_. Bound values are never parsed as
SQL: Postgres receives the statement and a list of values, and a value
containing `'); DROP TABLE users; --` is a string with those characters in it,
nothing more.

`SET`, `GRANT`, `CREATE ROLE` and other DDL cannot take bind parameters — a
placeholder inside a `DO` block's body is the literal text `$1`, not a
parameter — so identifier interpolation is sometimes unavoidable. That is a
reason to be careful and to write it down, not a reason to skip the check: the
interpolated piece must be a value the file itself fixes, never something a
request, a row, or an environment variable supplied.

Why the naive-looking form is not enough: `Prisma.raw(text)` interpolates at
_build_ time and `Prisma.sql\`... ${Prisma.raw(x)} ...\`` therefore looks like a
parameterized query while doing string concatenation. It is the one construct
this review asks a reviewer to catch by eye, because it is deliberately shaped
to pass a lint rule.

## Raw-query call sites

Every `$queryRaw`, `$queryRawUnsafe`, `$executeRaw` and `$executeRawUnsafe` in
the repository, with its verdict. `grep -rn '\$\(query\|execute\)Raw' --include=*.ts
apps packages tests` is the full method; `packages/database/prisma/migrations/**`
was read separately (see below).

| Site                                                                         | Statement                                                          | Verdict                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/identity/infrastructure/persistence/prisma-tenant-context.ts:39`   | `SELECT set_config($1, $2, true)`                                  | **Safe.** Tagged template; both the setting name and the tenant id are bound.                                                                                                                                                                         |
| `tests/integration/index-usage.spec.ts:70`                                   | `EXPLAIN SELECT …` with `$1::citext` placeholders                  | **Fixed in this change.** Was `` `EXPLAIN ${sql}` `` — a raw call fed a built string. Each caller now passes the complete statement literal, so nothing is concatenated.                                                                              |
| `tests/integration/index-usage.spec.ts:205`                                  | `ANALYZE users, organizations, …;`                                 | **Safe.** One fixed literal, no interpolation, no parameters.                                                                                                                                                                                         |
| `packages/sessions/infrastructure/testing/prisma-session-repository.spec.ts` | `CREATE DATABASE "…"` / `DROP DATABASE IF EXISTS "…"`              | **Documented exception.** DDL identifiers cannot be bound. The name comes only from `scratchDatabaseName()` (fixed prefix, pid, random hex). Disabled with the reason stated in the file. Its `EXPLAIN`/`ANALYZE` calls use the tagged-template form. |
| `packages/database/scripts/benchmark-audit-queries.ts:84`                    | `EXPLAIN (ANALYZE, BUFFERS) SELECT …` with `$1`/`$2` placeholders  | **Fixed.** Was `` `EXPLAIN (ANALYZE, BUFFERS) ${sql}` ``, the same shape as finding 2. Each caller now passes the complete statement literal; values are bound.                                                                                       |
| `tests/integration/row-level-security.spec.ts:73-85`                         | `DO $$ … CREATE ROLE … $$`, `GRANT … TO …`                         | **Documented exception.** DDL identifiers cannot be bound. `APP_ROLE`/`APP_PASSWORD` are constants declared at the top of the file; nothing runtime reaches them. Disabled with the reason stated in the file.                                        |
| `tests/integration/row-level-security.spec.ts:179-236`                       | `SELECT set_config('app.current_organization_id', ${ORG_A}, true)` | **Safe.** Tagged template, bound value.                                                                                                                                                                                                               |
| `tests/integration/injection-hardening.spec.ts`                              | `SELECT current_setting($1)` / `::uuid`                            | **The adversarial-input test for the production site.** Feeds payloads shaped like SQL and asserts the database treated them as data.                                                                                                                 |
| `packages/identity/infrastructure/persistence/prisma-tenant-context.spec.ts` | (captures the template, no database)                               | **Unit companion.** Asserts the `{ text, values }` split, so the binding claim holds without a running Postgres.                                                                                                                                      |

**Migrations.** All nine migrations under
`packages/database/prisma/migrations/` are static DDL: no `DO` blocks, no
`EXECUTE`, no string concatenation, and no `GRANT`/`REVOKE` at all. The RLS
migration (`20260904033449_enable_row_level_security/migration.sql`) reads
`current_setting('app.current_organization_id', true)` inside `CREATE POLICY`
and casts it with `::uuid` — parameterless, and the reason a non-uuid tenant id
fails closed rather than matching rows.

## Command execution

| Site                                                               | Form                                                                                                       | Verdict                                                                                                              |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `packages/identity/infrastructure/testing/database-harness.ts:83`  | `execFileSync("docker", ["info"])`                                                                         | **Safe.** Argument array, no shell.                                                                                  |
| `packages/identity/infrastructure/testing/database-harness.ts:103` | `execFileSync("pnpm", ["exec","prisma","migrate","deploy"], { env, shell: process.platform === "win32" })` | **Safe, with a caveat below.** The argv is a constant; `DATABASE_URL` is passed through `env`, not the command line. |
| `tests/integration/seed.spec.ts:30`                                | `execFileSync("pnpm", ["run","db:seed"], { env, shell: process.platform === "win32" })`                    | **Safe, same caveat.**                                                                                               |
| `packages/sessions/infrastructure/testing/redis-harness.ts:70`     | `execFileSync("docker", ["info"])`                                                                         | **Safe.**                                                                                                            |
| `scripts/issues/push.mjs:95`                                       | `spawnSync("gh", args, { shell: false })`                                                                  | **Safe.** Tooling script, repository-internal arguments, not part of any package's lint or test surface.             |

**The caveat worth remembering:** `shell: true` is there because `pnpm` is a
`.cmd` shim on Windows, and the lint rule does **not** cover `execFileSync` —
calling it with an array is the safe pattern and the rule would flag a
well-intentioned "fix" that switched it to a string. So the protection at these
sites is the constant argv, not the API choice. If an element of one of those
arrays ever becomes a runtime value, no tool will warn you.

No `exec`, `execSync`, `fork`, `eval`, `new Function` or `vm.runIn*` appears in
any package or in `apps/`.

## Categories checked, and clean

- **Prisma argument injection** (a `where`/`orderBy`/`select` built from
  request input, the SQL-flavoured cousin of `$where` in Mongo): every
  `orderBy` in the repository is a literal, no `where` object is assembled from
  a request body, and no dynamic key is ever computed into a Prisma argument.
  `apps/api` validates input against JSON Schema _before_ a use case sees it,
  and `additionalProperties` rejection (`removeAdditional: false`) means a
  caller cannot smuggle a field into an object that later reaches the database.
- **NoSQL / Redis**: no document store is used. The only Redis surface
  (`packages/sessions/infrastructure/redis-revocation-list.ts`) builds keys in
  `keyFor` as `` `${this.keyPrefix}${sessionId}` ``, where `sessionId` is a
  `randomUUID()`-derived branded id — see `domain/value-objects/session-id.ts`,
  whose own doc comment says never call `asSessionId` on untrusted input. No
  Lua scripting (`eval`/`evalsha`) anywhere, which is where Redis injection
  normally lives.
- **Path traversal**: no `fs.writeFile`/`createWriteStream` in shipped code, and
  no `path.join` whose components come from a request or a row.
- **Outbound URLs**: `packages/stellar-anchor` builds a Horizon client from a
  fixed per-network URL (or a config override), never from request data. See the
  finding below for the one variable path segment.
- **Log injection**: logging is structured pino with a redaction list
  (`packages/shared-kernel/infrastructure/logger.ts`), so a newline in a logged
  value cannot forge a line. Where a value is _projected_ into a log field the
  field list is fixed rather than spread from the payload
  (`apps/api/src/routes/csp-report.ts`) — that endpoint is unauthenticated, so
  it is the place most worth being picky about.

## Findings and how they were resolved

**1. The Stellar adapter sent an unvalidated string into an outbound URL.**
`StellarHashAnchor.verify(hash, anchorRef)` interpolated `anchorRef` into a
Horizon path segment and repeated it in an error message. `@stellar/stellar-sdk`
percent-encodes path segments, so this was not exploitable for traversal, but it
was a request-shaped hole with no validation next to one that had it.
**Fixed:** `verify` now requires `anchorRef` to be a 64-character lowercase hex
transaction hash — the same check `hash` already had — and refuses before making
a request. Covered by
`packages/stellar-anchor/infrastructure/stellar/stellar-hash-anchor.spec.ts`,
which asserts the rejection message is a constant (so it cannot echo the input)
and that nothing left the process.

**2. `EXPLAIN ${sql}` in the index-usage suite.** A raw call fed a built string,
in a file where the pieces happened to be local literals. **Fixed** by moving
`EXPLAIN` into each caller's own statement literal, so every statement the suite
runs is a single fixed string. The version that stayed would have been a
disable comment, and a disable comment on a _convenience wrapper_ is how this
rule gets trained away.

**3. DDL in the RLS suite.** Not fixable, and safe as written. **Documented** in
the file itself and here; carries a scoped `eslint-disable` naming the reason.

No finding is open.

## The lint rule

`eslint.config.mjs`, the two blocks titled "Injection hardening". They use
`no-restricted-syntax` with esquery selectors rather than a custom plugin: the
pattern being banned is a shape in the AST, and a declarative selector is
reviewable in the config file itself.

**Every `.ts` file** is checked for:

- concatenation (`BinaryExpression` with `+`) or a plain template literal fed to
  `$queryRaw`, `$queryRawUnsafe`, `$executeRaw`, `$executeRawUnsafe`;
- the same for `exec`/`execSync`, whose argument is a command line handed to a
  shell.

**Shipped code only** (`apps/**`, and `packages/*/{domain,application,
infrastructure}/**`) additionally cannot call `$queryRawUnsafe`/
`$executeRawUnsafe` at all, and cannot call `exec`, `execSync`, `eval` or
`new Function`. Tests may still need DDL; production code never does, because
every statement it runs can be parameterized.

**Deliberately not flagged:**

- The tagged-template form `prisma.$executeRaw\`… ${value} …\``. It is the safe
pattern, and it is a `TaggedTemplateExpression`, not a `CallExpression`, so
  the selectors never reach it. This is why the rule reads the way it does:
  "looks like interpolation" is not the property being tested, "a value was
  written into statement text" is.
- `execFileSync`/`spawnSync` with an array. Correct usage; flagging it would
  push people toward the string form.
- `Prisma.raw()` inside `Prisma.sql`. **Not** caught, and it is the one construct
  that needs a human. If a diff introduces it, treat it as the concatenation it is.

Adding a new exception should mean adding a narrow, commented `eslint-disable`
at the site — never widening a selector. Selectors here are blunt on purpose:
they exist to make someone look, and a rule that never fires is a rule that
someone will forget about.

## Reviewer checklist for a raw query

1. Does this need to be raw at all? Prisma's query builder covers it in nearly
   every case in this repository, and a builder call cannot be injected.
2. Is every value an interpolation _into the tagged-template form_, so it binds?
   A `+`, a `${}`, or a `Prisma.raw` is the answer "no".
3. If it is DDL and identifiers must be interpolated: is the interpolated piece
   a constant that this file owns? Can a request, a queue message, a database
   row, or an environment variable ever reach it? Write the answer in the
   disable comment and add a row to the table above.
4. Would the statement still be one statement if the value were malicious?
   Multi-statement text is not a theoretical concern here: it is exactly what a
   `'); …` payload is trying to produce.
5. Does a test exist that would fail if this line were changed to concatenation?
   `tests/integration/injection-hardening.spec.ts` is the model — it reads the
   value back out of the database rather than trusting the shape of the call.
