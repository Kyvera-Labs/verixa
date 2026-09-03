# Database

Verixa uses PostgreSQL. This guide covers what's set up so far (Issue 041:
provisioning, connectivity, dev/test isolation) — it grows through Phase 03
as Prisma, migrations, and real repositories land.

## Local Postgres

`docker compose up postgres` starts a single Postgres 16 container that
provisions **two** databases on first start:

- `verixa` — the development database, `DATABASE_URL` in `.env.example`
  points here.
- `verixa_test` — a separate database for tests, `TEST_DATABASE_URL` points
  here. Created by `infra/postgres/init-test-db.sh`, which the official
  Postgres image runs automatically on first container start (anything
  under `/docker-entrypoint-initdb.d/` executes once, the first time the
  data volume is empty).

### Why tests need their own database, not the dev one

A test suite that creates, mutates, and deletes rows is fundamentally
incompatible with a database a developer is also interactively poking at —
a test truncating a table mid-manual-debugging session, or a developer's
half-finished manual data change silently breaking a test's assumptions
about starting state, are both real, recurring sources of "why did this
just fail, it worked five minutes ago" confusion. Two logically separate
databases on the same Postgres server is enough isolation for local
development. It stops there deliberately, though: `verixa` and
`verixa_test` still share one Postgres _process_, so a truly broken test
(exhausting connections, for example) can still affect the other database's
availability. Issue 047 replaces this with fully ephemeral, per-test-run
containers (Testcontainers) for automated/CI test runs, which is a
stronger isolation guarantee than two databases sharing a server —
tracked here as future work, not implemented yet.

## Connection configuration

`DATABASE_URL` flows through `@verixa/config` (`packages/config/index.ts`)
like every other environment variable — validated as a URL at startup,
defaulted to the local dev value if unset, fails fast with a readable error
if malformed. No repository reads it yet (that starts with Issue 046,
alongside Prisma), but the config plumbing is in place now rather than
being bolted on later.

`TEST_DATABASE_URL` is deliberately **not** part of `@verixa/config` — the
running application server never needs to know about the test database, so
adding it to the app's config schema would be scope creep onto a
test-infrastructure concern. Test code reads it through
`tests/integration/helpers/database.ts`, which also builds the Prisma
client for tests with that URL passed **explicitly** rather than relying on
the ambient `DATABASE_URL` the schema reads. That matters: a suite that
deletes rows should never be one environment variable away from doing it to
a developer's own development database.

## Waiting for Postgres to be ready

`pnpm db:wait` (`scripts/db-wait.mjs`) polls a plain TCP connection to
`DATABASE_URL`'s host:port until it succeeds or times out (30 attempts,
1s apart). It's a standalone Node script, not a workspace package — no
`pg` driver dependency, just `node:net` — because "is anything listening on
this port yet" doesn't require speaking the Postgres wire protocol. That's
weaker than "Postgres has finished initializing and is ready for queries"
(a container can accept a TCP connection slightly before the database
behind it is fully up), which is why `docker-compose.yml`'s own
`healthcheck` (`pg_isready`, the real Postgres readiness check) is still
the authoritative signal for `depends_on: condition: service_healthy` in
that file. `db:wait` exists for contexts without compose's health-check
orchestration to lean on — a plain shell script, a CI step before compose
is involved, or a developer who wants to know from the command line.

## Verifying connectivity

`tests/integration/database.spec.ts` asserts a real TCP connection to
`TEST_DATABASE_URL` succeeds — no application code, no ORM, just proof that
whatever's running there is reachable from wherever the test is. It shares
its connection-check helper (`tests/integration/helpers/tcp-connect.ts`)
with nothing else in the codebase on purpose: `scripts/db-wait.mjs` needs
the identical logic but is a dependency-free root-level script outside any
workspace package's TypeScript project, so importing between the two would
mean crossing a boundary that doesn't otherwise exist. Duplicating ~15
lines was the simpler, more honest choice than inventing a shared module
for it.

### Running it

- **Locally**, this test **skips** when nothing is listening on
  `TEST_DATABASE_URL`'s port, so `pnpm test` passes on a fresh clone with
  no Docker running. Start `docker compose up postgres` to actually run it.
  See "Database-backed tests" below for why skipping is the local default
  and how CI prevents that from hiding missing coverage.
- **In CI**, `.github/workflows/ci.yml`'s `ci` job runs a `postgres:16-alpine`
  GitHub Actions **service container** (`services: postgres:`) — a
  lighter-weight mechanism than `docker compose` for CI specifically:
  GitHub starts and health-checks it automatically, alongside the job (not
  inside a separate container the job has to reach across a network), so it's
  reachable at plain `localhost:5432` from every step with no extra
  networking setup. `TEST_DATABASE_URL` is set as a job-level `env` var
  pointing at it.

## Prisma and the migration workflow

`packages/database` (`@verixa/database`) owns the schema, the migration
history, and the generated Prisma client. Everything database-related lives
in that one package rather than at the repo root, for the same reason every
other capability is a package: `apps/api` and the repository adapters
declare an explicit dependency on it, and pnpm's strict `node_modules`
resolution then guarantees the generated client is actually reachable from
the packages that import it — which a root-level `prisma/` directory does
not.

There is **one** schema and **one** migration history for the whole system,
not one per bounded context. That follows directly from
`docs/adr/0002-multi-tenancy-model.md`: all tenants share the same tables,
isolated by a row-level `organization_id` and Postgres RLS. Separate
contexts own separate _tables_, but they live in the same database, so they
migrate together.

### Commands

```bash
pnpm db:generate         # regenerate the Prisma client from schema.prisma
pnpm db:migrate          # create + apply a migration (development)
pnpm db:migrate:deploy   # apply existing migrations (CI/production)
pnpm db:migrate:status   # show which migrations have/haven't been applied
```

### The generated client is not committed

`pnpm db:generate` writes the client into `node_modules`, and it ships a
compiled query-engine binary specific to the platform that generated it — a
client generated on Windows will not run on the Linux container in CI. It's
git-ignored for that reason, which means **a fresh clone must run
`pnpm db:generate` before anything that imports `@verixa/database` will
build, typecheck, or run.** CI does this explicitly as its own step, before
`pnpm build`, for exactly the same reason the build step runs before lint
(see `docs/guides/ci-cd.md`).

`packages/database/index.spec.ts` exists mostly to make that failure mode
obvious: if generation was skipped, it fails on a plain assertion about the
exported client rather than surfacing as a confusing type error somewhere
several layers away.

### `migrate dev` vs. `migrate deploy`

- **`pnpm db:migrate` (`prisma migrate dev`)** is for development. It
  diffs `schema.prisma` against the database, generates a new SQL migration
  file, applies it, and regenerates the client. It can also **reset the
  database** when it detects drift — which is fine locally and catastrophic
  in production.
- **`pnpm db:migrate:deploy` (`prisma migrate deploy`)** is for CI and
  production. It only applies migration files that already exist, in order,
  and never generates, edits, or resets anything. This is the one that runs
  in the deploy pipeline.

Using the wrong one in production is a genuinely destructive mistake, which
is why they're separate named scripts here rather than one script with a
flag.

### Why migrations, not schema sync

Prisma also offers `db push`, which shoves the current schema straight into
the database with no migration file. It's faster while prototyping, and the
wrong tool the moment anything real depends on the database.

A migration file is a **record of a specific change, in order, that can be
replayed**. That matters for three things `db push` can't do:

1. **Reproducibility.** Every environment — a teammate's laptop, CI, staging,
   production — arrives at the same schema by applying the same ordered list
   of changes, rather than each independently syncing to whatever the schema
   file happens to say today.
2. **Review.** A migration is a diff a human can read in a pull request:
   "this drops a column" is visible before it runs. Schema sync hides the
   destructive step inside a tool's diffing logic, where nobody reviews it.
3. **Data changes, not just structure.** Real schema changes often need
   accompanying data changes — backfill a new non-null column before adding
   the constraint, split one column into two. That's SQL that has to run
   _between_ two structural states, which only exists in a migration-based
   workflow.

Verixa sets this workflow up in Issue 042, **before any table exists**,
deliberately. Retrofitting migration history onto a database that was built
by schema sync means reconstructing a history nobody recorded — so the
cheapest possible moment to establish it is when there's nothing to
reconstruct.

CI runs `db:migrate:deploy` on every push, applying every migration in
order against a fresh Postgres service container — so a migration that
doesn't apply cleanly fails the build rather than surfacing on someone's
machine later.

## Schema

### `users` (Issue 043)

The persisted form of the `User` aggregate
(`packages/identity/domain/entities/user.ts`).

| Column         | Type             | Notes                                          |
| -------------- | ---------------- | ---------------------------------------------- |
| `id`           | `uuid` PK        | Assigned by the domain, never by the database  |
| `email`        | `citext` UNIQUE  | Case-insensitive; see below                    |
| `display_name` | `text`           | Always present                                 |
| `given_name`   | `text` NULL      | Optional structured name                       |
| `family_name`  | `text` NULL      | Optional even when a given name exists         |
| `status`       | `user_status`    | Enum: `pending`/`active`/`suspended`/`deleted` |
| `created_at`   | `timestamptz(3)` |                                                |
| `updated_at`   | `timestamptz(3)` |                                                |

Three decisions in that table are worth explaining, because each one has a
common alternative that's subtly worse.

**The id is not database-generated.** There's deliberately no
`@default(uuid())`. `User.register()` produces a complete, valid `User` —
identity included — before anything touches persistence, which is what
makes the domain layer testable without a database at all. Letting the
database mint the id would invert that: an entity would only become fully
real once saved, and every test would need a database to produce one.

**`email` is `citext`, not `text`.** The domain already lowercases in
`Email.create()`, so in normal operation every stored value is already
lowercase and `citext` changes nothing. It earns its place as the second
line of defense — a raw SQL insert, a data migration, a bulk import, or a
future code path that skips `Email.create()` could otherwise create two
accounts differing only in case, which is an account-takeover-adjacent bug
rather than a cosmetic one. This is the same defense-in-depth principle
applied throughout: enforce an invariant in the domain _and_ in the
database, because the two protect against different failure modes.

The usual alternative is `text` plus a functional unique index on
`LOWER(email)`. That achieves uniqueness and is a well-known footgun:
Postgres only uses a functional index when a query's `WHERE` clause matches
its expression exactly. So `WHERE email = $1` silently falls back to a
sequential scan while `WHERE LOWER(email) = LOWER($1)` uses the index —
meaning every query site has to remember the wrapper, and the one that
forgets is both slow _and_ case-sensitive. `citext` moves that correctness
into the column type, where it can't be forgotten. `users-table.spec.ts`
tests both halves: that a case-differing duplicate is rejected, and that a
plain equality lookup matches case-insensitively.

**Timestamps are `timestamptz`, not `timestamp`.** Prisma's default for
`DateTime` on Postgres is `timestamp` — no timezone — which silently
reinterprets values against whatever the session timezone happens to be.
That produces hour-shifted timestamps that only appear once a server, a
developer laptop, and a CI runner disagree about local time. Identity and
audit records need an unambiguous instant.

**One known gap.** `given_name` and `family_name` are independently
nullable, so the database permits a family name with no given name — a
state the domain's `PersonName` cannot represent. Closing it needs a
`CHECK` constraint, which Prisma's schema language can't express and which
would have to be hand-written into a migration. That's deferred rather than
guessed at: this environment has no local Postgres to verify how Prisma's
drift detection treats a constraint it can't model, and adding an
unverifiable hand-edit to the migration history could break `migrate dev`
for every contributor. It's a real gap, worth closing once it can be
tested against a live database.

### Objects Prisma does not manage

Two kinds of database object in this schema exist only in migration SQL,
because Prisma's schema language cannot express them:

- The **partial unique index** on `organization_memberships` (Issue 044),
  which constrains only rows where `status = 'active'`. Prisma's `@@unique`
  has no `WHERE` clause. A plain composite unique would be wrong — it would
  forbid rejoining an organization after leaving it.
- Any **`CHECK` constraint**, including the one `users.given_name` /
  `family_name` still wants (Issue 043).

The consequence to be aware of: `prisma migrate dev` derives new migrations
by diffing `schema.prisma` against migration history, and it cannot see
these objects. They are applied by their migration and stay in the database,
but Prisma will not recreate them if it ever regenerates the schema, and it
will not warn you they exist. Treat them as append-only: add via raw SQL in
a migration, never expect Prisma to manage them afterwards.

## Database-backed tests

Tests needing a real Postgres live in `tests/integration/` and follow one
pattern:

```ts
const available = await databaseAvailability();

describe.skipIf(!available)("users table", () => { ... });
```

They **skip** when no database is reachable, so `pnpm test` passes on a
fresh clone with nothing running — a contributor's first command shouldn't
fail for reasons unrelated to their change.

The obvious hazard is that skipping hides missing coverage: a misconfigured
CI service container would make every database test skip and still report
green. CI therefore sets `REQUIRE_DATABASE_TESTS=1`, which turns an
unreachable database into a hard failure.

That check runs at module top level rather than in `beforeAll`, and the
reason is worth recording. Vitest skips a suite's hooks along with its
tests, so an assertion inside the `beforeAll` of a `describe.skipIf`-ed
block never executes — the first version of this guard silently did nothing
in precisely the situation it existed to catch. Module evaluation always
runs, so throwing there fails collection reliably.

## What's next (Phase 03)

- **Issues 044–045**: tables for `Organization`/`OrganizationMembership`
  and `Invitation`.
- **Issue 046+**: real, Prisma-backed repositories satisfying the ports
  from Phase 02, validated against the contract test suite from Issue 031.
- **Issue 047**: Testcontainers, replacing the shared `verixa_test`
  database above with fully ephemeral per-test-run containers.
