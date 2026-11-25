# Mutation testing

Line coverage tells you which code ran during the tests, not whether the
tests would notice if that code were wrong. Mutation testing measures the
second thing. It makes small deliberate changes to the code (`>` becomes `>=`,
a filter is removed, a string is emptied) and checks whether any test fails.
A change no test notices is a _surviving mutant_: a behaviour the suite does
not actually pin down.

This guide covers the pilot: what runs, where, why only these two packages,
how the thresholds were set, and how to work with the report (Issue 417). The
evidence behind the decision to adopt is in
[`mutation-testing-spike.md`](./mutation-testing-spike.md) (Issue 416).

## What runs

| Package                 | Config                                     | What is mutated                                                                | `break` |
| ----------------------- | ------------------------------------------ | ------------------------------------------------------------------------------ | ------: |
| `@verixa/shared-kernel` | `packages/shared-kernel/stryker.conf.json` | `domain/`, `application/` (not `ports/`), `infrastructure/`, `interface/`      |      80 |
| `@verixa/identity`      | `packages/identity/stryker.conf.json`      | `domain/`, `application/use-cases/`, `infrastructure/testing/` (not contracts) |      70 |

Both use [Stryker](https://stryker-mutator.io/) with its Vitest runner, so
mutants are judged by the package's ordinary `vitest.config.ts` and specs.
Nothing is written for Stryker specifically.

**In CI**, `.github/workflows/mutation-testing.yml` runs one job per package
when that package, the workflow or the lockfile changes. Each job:

1. restores the package's incremental results from the cache (its branch's
   last run, falling back to `main`'s);
2. runs `pnpm --filter @verixa/<package> run test:mutation`, which fails when
   the score is under `break`;
3. writes the score to the job summary, read from Stryker's own JSON report;
4. uploads `mutation.html` and `mutation.json` as the
   `mutation-report-<package>` artifact for 30 days.

It is a separate workflow, not a step in `ci.yml`, because a full run costs
many times a normal test run (see [Cost](#cost)). Inside `ci.yml` it would
swamp the test-duration budget that job enforces
([performance-budget.md](./performance-budget.md)).

## Why these two packages

- **shared-kernel** is imported by every other package, so a weak test there
  is weak everywhere.
- **identity** holds the rules that decide who belongs to what: membership
  status, organization identity, API key and invitation expiry.

In the spike, both already had good line coverage (88% and 93%), and both
still had real gaps that coverage could not show. Examples: a removed
`status === "active"` filter, an email pattern without its `$` anchor, and
expiry checks that were never tested at the exact instant. Every line
involved ran; no test checked the result.

**Why not more packages yet:** identity alone took 53 minutes for a full run
at concurrency 1 in the spike. Across every package that would be hours, and
nobody would review hundreds of survivors. See
[Widening the pilot](#widening-the-pilot) for when to add one.

## Thresholds

Stryker's score is `(killed + timed out) / (killed + timed out + survived +
no coverage)`.

| Package       | Spike | After the pilot's tests | `break` | `low` / `high` (report colours only) |
| ------------- | ----: | ----------------------: | ------: | -----------------------------------: |
| shared-kernel | 84.19 |                   97.67 |      80 |                              80 / 90 |
| identity      | 75.81 |                   85.00 |      70 |                              75 / 85 |

identity's spike figure is measured over the same files the pilot mutates,
i.e. without `infrastructure/testing/contracts/` (see below).

**`break` is set below the measured score on purpose.** The gate exists to
catch regressions, not to demand a number the code has never reached. It
starts green and fails when a change lowers the score past it.

**Why not raise `break` to the new scores now:** the margin absorbs mutants
that are equivalent (no test can kill them because the mutated code behaves
identically, listed below), and Stryker version changes that add new
mutators. Raise it deliberately, in its own change, once the score has been
stable for a while. **Never lower it silently.** A lowered threshold needs
its reason in the PR description.

### What is excluded and why

- **`*.spec.ts`**: the tests themselves.
- **shared-kernel `application/ports/`**: interfaces only, nothing to mutate.
- **identity `infrastructure/testing/contracts/`**: these are the shared
  repository contract suites. Mutating a test suite asks whether the tests
  of the tests are good, which is not the question. In the spike they added
  144 mutants, mostly surviving, and pulled identity's score from 75.81 to
  69.24.
- **identity `infrastructure/testing/database-harness.ts`**: test
  infrastructure for the Postgres-backed specs, which skip without a
  database.
- **identity `infrastructure/persistence/`**: the Prisma
  repositories need a real database, which mutation runs do not start (CI
  sets `TEST_DATABASE_URL` to a closed port so those specs skip). Mutating
  code whose tests skip only produces "no coverage" noise.

### Survivors that are accepted

These survive because the mutated code cannot behave differently, not
because a test is missing. Do not write tests that try to kill them.

- `brute-force-policy.ts:239`: the `stepsPastThreshold > 64` overflow cap
  (`>` → `>=`, or removing it). `Math.min(…, maxDurationMs)` caps the result
  afterwards anyway, so the early cap only matters when `baseDurationMs` is 0.
- `logger.ts:57`: the `options.redact ?? []` fallback replaced with
  `["Stryker was here"]`. That adds one extra redaction path that no real
  field matches; the default paths are still applied (and tested).
- `logger.ts:62`: `if (options.name !== undefined)` → `true`. Passing
  `name: undefined` to pino behaves the same as omitting it.
- identity's length checks before `timingSafeEqual` in `matchesKey` and
  `matchesToken`. Both sides are SHA-256 digests, always 32 bytes, so the
  check never fires. It is there so `timingSafeEqual` can never throw if
  the hash ever changes. Do not remove it.

`validation.ts:59`, the default `"Validation failed."` message, also
survives. That is a real but minor gap: no caller relies on the default text.
It is left as-is.

### Known gaps still open in identity

The pilot fixed the gaps the spike listed. identity's remaining 111
survivors and no-coverage mutants are mostly error-message text (see the
spike's "low value" note). The ones below are real gaps, left for follow-up
work rather than widened into this change:

- `organization-membership.ts:54,57`: the active-duplicate check in
  `OrganizationMembership.create`. No test gives it an existing membership
  in a _different_ organization, so a check that ignored the organization
  would pass.
- `user.ts:29,30`: entries in the status-transition table (`suspended`'s
  allowed targets, `deleted`'s empty set) that no test exercises.
- The `eventName` strings of four domain events
  (`user-registered.ts`, `user-status-changed.ts`, `user-profile-updated.ts`,
  `organization-invitation-created.ts`). They are a published contract for
  subscribers, and no test pins them.
- `infrastructure/testing/in-memory-api-key-repository.ts` has no coverage
  at all, and the filters in the in-memory membership and organization
  repositories survive. Those fakes stand in for Postgres in every use-case
  test, so a fake that ignores a filter can hide a use-case bug.

## Running it locally

```bash
cd packages/shared-kernel    # or packages/identity
pnpm run test:mutation
```

Then open `reports/mutation/mutation.html`. The first run is a full run;
after that, incremental mode re-tests only mutants in code or tests that
changed since the last run (results are kept in
`reports/mutation/stryker-incremental.json`). To force a full run, delete
that file or pass `--force`.

`reports/mutation/` and `.stryker-tmp/` are gitignored.

**On a small machine**, pass `--concurrency 1` (the default is one runner per
CPU core minus one, each a separate Vitest process). The pilot's local
measurements were taken that way on a 4-thread laptop with 6 GB of RAM.

**identity on Node older than 22.19:** the Prisma repository spec fails to
import there (undici needs 22.19+). Leave it out of the sandbox:

```bash
pnpm run test:mutation --ignorePatterns "dist,coverage,reports,infrastructure/persistence/prisma-repositories.spec.ts"
```

## Reading the report

Open `mutation.html`, pick a file and look at the red markers. Each one is a
mutant, and its status says what happened:

- **Killed**: at least one test failed. Good.
- **Survived**: every test passed with the change. Either a test is
  missing, or the mutant is equivalent (see above).
- **No coverage**: no test even ran that line.
- **Timeout**: the change caused an infinite loop or hang. Counted as
  detected.

When a mutant survives, ask: _if someone made this change on purpose, would
it be a bug?_ If yes, write the test that would catch it, and name the
mutant in a comment (`// Kills foo.ts:42 (\`>\` -> \`>=\`)`), as the pilot's
tests do. That comment is what stops a later reader from deleting the test as
redundant. If no, it is equivalent: add it to the list above.

A test written only to raise the score, asserting implementation details no
caller depends on, is worse than the survivor. Pin behaviour, not code.

## Cost

Measured locally, full runs, `--concurrency 1`, as reported by Stryker:

| Package       | Spike full run                       | Pilot full run                |
| ------------- | ------------------------------------ | ----------------------------- |
| shared-kernel | 215 mutants, 1,007s                  | 215 mutants, 210s (3m 30s)    |
| identity      | 884 mutants (with contracts), 3,187s | 740 mutants, 1,405s (23m 25s) |

shared-kernel's pilot run was about 4.8 times faster than the spike's, on the
same machine with the same mutants. Stryker's own dry run shows where the
time went: 14s of Vitest start-up overhead in the pilot, against 77s in the
spike. The cause has not been isolated. The likeliest explanation is memory
pressure, because the machine has 6 GB. One attempt at the identity pilot
run tested 491 mutants in its first 13 minutes, then took nearly 3 more
hours to reach 644 once free RAM fell to about 300 MB, and was stopped
there. Treat the spike figures as upper bounds, not typical runs.

**Incremental runs are cheap.** After shared-kernel's full run, the
incremental run that followed a spec-only change to `domain/errors.spec.ts`
reused 211 of 215 results and took 56s (78s including pnpm and process
start-up). identity's, after a one-test change, reused 739 of 740 and took
1m 45s.

**In CI** the runner has more cores and Stryker uses them all, and
incremental mode means a typical PR re-tests only the mutants in the files
it touched. **TODO(measure):** the first CI runs give the real per-PR
numbers. The job timeout is 30 minutes. If incremental runs start
approaching it, see below before raising it.

### When it is too slow

In order of preference:

1. Check the incremental cache is being restored (the Stryker log says
   "No incremental result file found" when it is not).
2. `--ignoreStatic`. Static mutants (code that runs only at import, like
   constants and top-level regexes) cannot use per-test coverage, so every
   test runs for each one. Stryker estimated them at 64% of shared-kernel's
   pilot time and 40% of identity's. The trade-off: some are real gaps (the
   email and slug regex anchors are static mutants).
3. Narrow `mutate`.

## Widening the pilot

Add a package when all of these hold:

- it holds rules whose failure is a security or data-integrity problem, not
  just a wrong label;
- its unit tests run without a database (otherwise most mutants are "no
  coverage" noise);
- someone will triage its first report: fix the real survivors, list the
  equivalent ones, then set `break` below the result.

Copy one of the two configs, adjust `mutate`, and add the package to the
workflow's `paths` and `matrix`.

## Alternatives considered

- **Run it inside `pnpm test` / `ci.yml`**: rejected, the cost would swamp the
  test-duration budget.
- **One repo-wide score**: rejected. It hides which package regressed, and
  equivalent mutants make the number meaningless across packages.
- **An external dashboard (Stryker Dashboard) for the badge**: rejected for
  the pilot. It needs an API token and sends the report to a third party. The
  job summary gives the same number from the same JSON, with nothing to
  configure.
- **A nightly full run instead of per-PR**: rejected. A survivor found the
  next morning has lost its author's context. Incremental per-PR runs keep
  the cost close to that of a nightly run while reporting on the PR that
  caused it.
