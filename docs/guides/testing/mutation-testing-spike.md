# Mutation testing spike

Does mutation testing tell us something the coverage gates don't, and can we
afford it? This is the time-boxed evaluation (Issue 416) that answers that,
and its recommendation decides whether Issue 417 (the pilot) goes ahead.

**Recommendation: adopt narrowly.** Run Stryker on `packages/shared-kernel`
and `packages/identity` only, in a separate path-filtered CI workflow with
incremental mode. Don't adopt it repo-wide. The reasoning is below.

## The question

A coverage gate answers "did a test _execute_ this line?". It can't answer
"would a test _fail_ if this line were wrong?". A test that calls a function
and asserts nothing useful counts toward coverage exactly as much as a good
one. `docs/guides/testing.md` already says coverage is "a floor, not a
target" for this reason.

Mutation testing asks the second question directly. Stryker makes one small
change to the production code at a time (flip `>` to `>=`, delete a method
call, empty a block), runs the tests against each changed copy (a _mutant_),
and records whether any test failed:

- **Killed:** a test failed. Good: the tests notice that change.
- **Survived:** every test still passed. Either a real test gap or an
  _equivalent_ mutant (a change that doesn't alter behaviour).
- **No coverage:** no test even executes that code.
- **Mutation score:** `(killed + timeout) / (all mutants except errors)`.

The cost is that the tests run once per mutant, hundreds of times per
package. The spike measures both the signal and that cost.

## Method

- **Tool:** Stryker Mutator 10.1.1 (`@stryker-mutator/core`,
  `@stryker-mutator/vitest-runner`), the Vitest runner, so the tests run
  exactly as `pnpm test` runs them.
- **Config:** `stryker.conf.spike.json` (JSON has no comments, so the choices
  are explained here):
  - `coverageAnalysis: "perTest"` runs only the tests that cover a mutant,
    which is Stryker's fastest correct mode for Vitest.
  - `incremental: false` makes every mutant run every time, so the timings are
    honest full-run costs.
  - `concurrency: 1`. The test machine had well under 1 GB of free RAM, and
    an earlier test run was killed for memory pressure. One runner keeps the
    run alive, at the cost of wall time (see "Cost").
  - Reporters `clear-text`, `html`, `json` write to `reports/mutation/` in each
    package. That directory and Stryker's `.stryker-tmp/` sandbox are
    gitignored.
  - `thresholds.break: null`. A spike measures, it doesn't gate.
- **Mutation scope = coverage scope.** Each package is mutated on exactly the
  files its line coverage is measured over, so the two numbers describe the
  same code. For identity, that's the existing coverage gate's scope from
  `packages/identity/vitest.config.ts` (no ports, persistence, database
  harness or scripts). shared-kernel has no gate, so its scope is every
  source file except specs, `index.ts`, the config and the interface-only
  `application/ports`.
- **Run from each package directory:**

  ```bash
  cd packages/shared-kernel
  node ../../node_modules/@stryker-mutator/core/bin/stryker.js run ../../stryker.conf.spike.json \
    --mutate "domain/**/*.ts,application/**/*.ts,infrastructure/**/*.ts,interface/**/*.ts,!**/*.spec.ts,!application/ports/**"

  cd packages/identity
  node ../../node_modules/@stryker-mutator/core/bin/stryker.js run ../../stryker.conf.spike.json \
    --mutate "domain/**/*.ts,application/use-cases/**/*.ts,infrastructure/testing/**/*.ts,!**/*.spec.ts,!infrastructure/testing/database-harness.ts" \
    --ignorePatterns "dist,coverage,reports,infrastructure/persistence/prisma-repositories.spec.ts"
  ```

  The identity `--ignorePatterns` entry is a local-machine workaround, not
  part of the method. On Node 22.14, that spec crashes on import
  (`undici@8.12.3` needs Node `>=22.19`), and Stryker refuses to start unless
  every test passes. The spec only exercises `infrastructure/persistence`
  (outside the mutation scope), and without a database it skips anyway, so it
  can kill no in-scope mutant. Leaving it out doesn't change the result.

- **Environment:** Windows 10, Intel i3-7100U (2 cores / 4 threads), 6 GB RAM,
  Node 22.14.0, no database (database-backed specs skip). 2026-11-20.

### Deviations from the roadmap issue

The issue names two dependencies that aren't on `main`, so two substitutions
were made:

- **No `packages/rate-limiting` token bucket (Issue 281, #313).** That package
  was suggested as the pure-domain candidate. `packages/shared-kernel` stands
  in: it's pure domain and application code with no I/O, and it's one of the
  two packages the pilot (Issue 417) targets anyway. When the token bucket
  lands, it's an obvious candidate to add (see
  [Widening the pilot](./mutation-testing.md#widening-the-pilot)).
- **No workspace coverage aggregation (Issue 412, #524).** The comparison
  uses each package's own `v8` line coverage over the same scope, which is
  what the issue's "compare against the existing line-coverage gates" needs.

The issue suggests 2–3 packages, including "an application-layer package with
more mocking". identity covers that: its use cases are tested against
in-memory repository fakes.

## Results

| Package       | Mutants | Killed | Survived | No coverage | Timeout | **Mutation score** | Line coverage (same scope) |
| ------------- | ------: | -----: | -------: | ----------: | ------: | -----------------: | -------------------------: |
| shared-kernel |     215 |    181 |       11 |          23 |       0 |         **84.19%** |                      87.8% |
| identity      |     884 |    604 |      207 |          64 |       6 |         **69.24%** |                      92.8% |

identity also had 3 runtime errors, mutants that broke the module outright.
They're excluded from the score by Stryker's formula.

**identity, corrected scope.** `infrastructure/testing/contracts/*.contract.ts`
are _test suites_ (shared repository contract specs that don't use the
`.spec.ts` suffix), and the coverage scope picked them up. Mutating test code
says nothing about production code, and they contributed 92 of the 271
surviving and uncovered mutants. Without them:

| identity scope                                 | Mutants | Mutation score | Score of covered mutants |
| ---------------------------------------------- | ------: | -------------: | -----------------------: |
| Everything in the coverage scope               |     881 |         69.24% |                   74.66% |
| Excluding contract suites                      |     740 |     **75.81%** |                   81.66% |
| Domain + application only (no in-memory fakes) |     621 |         76.17% |                   80.85% |

Any pilot config must exclude `infrastructure/testing/contracts/**` from
`mutate`.

### Where coverage and mutation score diverge

**identity: 92.8% line coverage, about 76% mutation score.** About one in
four changes to code the tests _execute_ goes unnoticed. shared-kernel's
gap is smaller (87.8% vs 84.2%), because its tests already assert specific
outputs for most branches.

The survivors cluster into four groups:

1. **Boundaries never pinned down.** `>` vs `>=` survives on most length
   limits: organization name and slug (`organization.ts:76,80,82`), display
   name (`display-name.ts:21,27`), email (`email.ts:40`), person name
   (`person-name.ts:35,39`), and the API key and invitation expiry instant
   (`api-key.ts:93,142`, `invitation.ts:151`). The tests check values well
   inside and well outside each limit, never _at_ it.
2. **Filters and normalisation that nothing asserts.** Real gaps, and some
   are security-relevant:
   - `get-user-organizations.ts:26` and `get-users-by-organization-ids.ts:42`:
     removing the `status === "active"` filter survives. A user who left an
     organization would still have it listed, and no test would fail.
   - `create-organization.ts:43`: removing `.trim()` from the slug the
     duplicate check uses survives. `" acme "` passes the check, then
     `Organization.create` trims it and a second `acme` is saved. Against
     Postgres, the unique index turns that into a 500 instead of a 409.
     (An earlier draft of this report said `.toLowerCase()`. Stryker prints
     only the replaced sub-expression, and the lowercase mutant was in fact
     killed.)
   - shared-kernel `brute-force-policy.ts:158`: the identifier sent to the
     **rate limiter** isn't checked for normalisation. The lockout-store
     key is (`brute-force-policy.spec.ts:65`), so this is a narrower gap
     than it first looks.
3. **Regex anchors.** Dropping `^` from `SLUG_SEGMENT_PATTERN`
   (`organization.ts:13`) or `$` from `EMAIL_PATTERN` (`email.ts:10`)
   survives. Without the `$`, `a@b.c@d` passes email validation. These are
   real validation holes that line coverage can't see, because the line
   always runs.
4. **Code with no tests at all.** In shared-kernel,
   `infrastructure/in-memory-event-publisher.ts` and
   `assertValidTenantId` (`infrastructure/tenant-context.ts:53`, the guard
   that stops an empty tenant id from silently matching zero rows under RLS)
   have no direct tests. Coverage reported this as missing lines.
   Mutation testing shows what's at stake in each one.

**Equivalent and low-value survivors.** Not every survivor is a gap:

- **Equivalent:** shared-kernel `brute-force-policy.ts:239` (`> 64` → `>= 64`,
  or removing the cap). `Math.min(…, maxDurationMs)` already caps the
  result, so the early cap only matters when `baseDurationMs` is 0.
  `logger.ts:62`: passing `name: undefined` to pino behaves the same as
  omitting it.
- **Low value:** the 86 `StringLiteral` survivors are mostly error message
  text (`user.ts:124`, `validation.ts:59`). Messages are documented as
  rewordable, so pinning them adds brittleness, not safety.
  `invitation.ts:31` (`7 * 24 * 60 * 60 * 1000` mutated) survives because no
  test checks the _default_ TTL. That's a small real gap.

These are why a threshold has to sit below 100%, and why survivors get
reviewed rather than auto-fixed.

## Cost

| Package       | `vitest run` (cold / warm) | Stryker full run | Overhead (vs cold / warm) |
| ------------- | -------------------------: | ---------------: | ------------------------: |
| shared-kernel |              77.5s / 33.2s | 1,007s (16m 47s) |                 13× / 30× |
| identity      |              43.8s / 27.5s | 3,187s (53m 07s) |                73× / 116× |

On this machine **the tests themselves are nearly free**. Stryker's dry run
reports shared-kernel's 78 tests as 0.53s of test time inside 77s of
process and transform overhead, and identity's 122 as 0.39s inside 25s. The
mutation run reuses one Vitest process across mutants, so most of the cost
per mutant (about 4.4s for shared-kernel, 3.6s for identity) is
re-evaluating the changed modules, not running assertions.

**Static mutants are about half the bill.** A mutant in code that runs only
at module load (a constant, a top-level regex) can't use per-test coverage,
so Stryker reruns every test for it. Stryker flagged 23 static mutants in
shared-kernel (11% of the mutants, about 45% of the time) and 61 in identity
(7%, about 55%). `--ignoreStatic` would roughly halve the run time, at the cost
of not testing those mutants. Some are real gaps (the regex anchors above
are static), so it's a trade-off, not a free win.

**Estimated CI cost per PR.** Not measured, since there were no CI runs during
the spike, so the following is arithmetic, not a claim:

- **Full run:** wall time ÷ concurrency. If a 4-vCPU `ubuntu-latest` runner
  matched this laptop per mutant at `concurrency: 3`, that's about 6 minutes
  for shared-kernel and 18 for identity.
- **Incremental mode** re-tests only mutants in changed code and tests, so a
  typical PR that touches a few files should cost a small fraction of that.
  The full cost recurs only when the incremental cache is missing.
- **TODO(measure):** the first pilot CI runs give the real numbers.

**Relation to the test performance budget (Issue 415).** Mutation testing
must not run inside the `unit`/`integration` suites the budget times. At
13–116× a normal run, it would swamp them. It belongs in its own
path-filtered workflow, with its own time limit.

## Recommendation

**Adopt narrowly: shared-kernel and identity, in CI, path-filtered,
incremental.**

**Why adopt at all.** In two packages that already had good line coverage
(88% and 93%), the spike found missing `active`-membership filters, an
unanchored email regex, unpinned expiry boundaries and an untested tenant-id
guard. None of these was visible as a coverage gap, because every line
involved runs. That's precisely the signal coverage can't give, and some of
it is security-relevant in a platform whose purpose is identity and access.

**Why these two packages.**

- shared-kernel is imported by everything, so a weak test there is weak
  everywhere.
- identity carries the authorization-adjacent rules (membership status,
  organization identity, API key expiry).
- Both are small enough to run, and both had concrete findings worth
  fixing.

**Proposed thresholds** for the pilot's `thresholds.break`, set below the
measured scores so the gate starts green and only catches regressions:

- **shared-kernel: 80** (measured 84.19).
- **identity: 70**, with contracts excluded from `mutate` (measured 75.81).

The pilot should raise both as it fixes the gaps above, never lower them
silently.

### Rejected

- **Adopt broadly** (every package, or as part of `pnpm test`). identity
  alone took 53 minutes at concurrency 1, and the overhead is 13–116× a
  normal run. Across 12 packages it would be hours per full run. With that
  many survivors, nobody would review them, which repeats the snapshot
  problem: a number nobody reads.
- **Defer.** The cost is real, but the findings are concrete and some are
  security-relevant. Deferring would leave known gaps that coverage reports
  as fine. The cost argument is answered by scope (two packages,
  path-filtered, incremental), not by not doing it.
- **Gate on a single repo-wide score.** One number hides which package
  regressed, and equivalent mutants make 100% unreachable. Per-package
  thresholds, reviewed when changed, are the honest unit.
- **Use `--ignoreStatic` by default.** It halves the time but skips real gaps,
  including the regex anchors. It's worth revisiting only if the pilot's
  incremental runs still exceed their time limit.

## Test gaps found (to fix in the pilot, not here)

The spike lists gaps. It doesn't fix them, so that the scores above stay a
true measurement. Issue 417 should add tests that kill, at least:

- **shared-kernel:**
  - `assertValidTenantId` (`tenant-context.ts:53–57`)
  - `InMemoryEventPublisher` subscribe and publish
  - rate-limiter identifier normalisation (`brute-force-policy.ts:158`)
  - `retryAfterSeconds` merging (`brute-force-policy.ts:170,177,219`)
- **identity:**
  - active-membership filtering (`get-user-organizations.ts:26`,
    `get-users-by-organization-ids.ts:42`)
  - slug trimming in the duplicate check (`create-organization.ts:43`)
  - the email and slug regex anchors
  - length boundaries in the value objects
  - API key and invitation expiry at the exact instant
  - `reactivate-user.ts` reason validation (`:34–47`)
  - the invitation default TTL
