# Test performance budget

A test suite that feels slow stops being run before pushing, and then it
only catches bugs after review, when they cost the most to fix. This guide
covers how suite speed is measured and enforced here, what was changed to make
the suites faster, and what's still blocked (Issue 415).

## What is measured

CI times two suites, which together are exactly what `pnpm test` runs:

| Suite         | Command                                                  | What's in it                                                                                                                                                                 |
| ------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unit`        | `pnpm -r --filter "!@verixa/integration-tests" run test` | Every package's colocated `*.spec.ts`. Mostly unit tests. With a database or Redis present (as in CI), the few Prisma/Redis repository specs in these packages run here too. |
| `integration` | `pnpm --filter @verixa/integration-tests run test`       | `tests/integration/` (real HTTP, real Postgres) and `tests/ci/` (the CI-tooling gates).                                                                                      |

There's no E2E suite yet. It arrives with Issue 405 (#517). Once it does, time it
with `measure --suite e2e`. Until a baseline entry exists the check reports it
as "no baseline" without failing.

**Wall-clock time, measured from outside.** `infra/ci/perf-budget.ts measure`
times the suite's whole command. It doesn't add up Vitest's per-test
durations. Under parallel workers those overlap, so their sum measures CPU used
rather than time waited, and it shrinks as parallelism grows. That's the
opposite of what a budget should reward.

## The check

```bash
# time a suite (appends to the timings file; exit code passes through)
pnpm perf:budget measure --suite unit --timings test-timings.json -- \
  pnpm -r --filter "!@verixa/integration-tests" run test

# compare against the committed baseline
pnpm perf:budget check --baseline infra/ci/perf-baseline.json --timings test-timings.json
```

A suite **regresses** when it takes longer than
`baselineSeconds × (1 + tolerancePercent / 100)`. The check:

- prints a table (Baseline / Limit / This run / Change / Status) and appends it
  to the GitHub job summary
- writes a JSON report, uploaded with the timings as the `test-duration`
  artifact
- exits `1` if a suite regressed, **or** if a suite in the baseline wasn't timed
  at all. Otherwise a suite could drop out of CI and its budget would go with
  it, silently.
- reports a timed suite that has no baseline entry, but doesn't fail on it. A
  new suite has no history, and failing would force someone to make a number
  up.
- exits `2` if the baseline or timings file is missing or malformed, the same
  convention as `dependency-scan.mjs`. A gate that can't read its input
  fails. It never passes.

`tests/ci/perf-budget.spec.ts` covers each of these rules by running the real
CLI.

## The baseline, and why it is provisional

`infra/ci/perf-baseline.json` currently holds **unit 222.6s, integration
138.8s, tolerance 30%**. These numbers were measured locally, not in CI
(see "Measurements" below), and the file's `source` field says so. Two
consequences:

- **The CI check is report-only** (`continue-on-error: true`). Comparing a CI
  runner against a laptop's numbers would flag or excuse regressions at
  random. The table and artifact are still produced on every run.
- **To make it blocking:** take `test-timings.json` from the `test-duration`
  artifact of several runs on `main`, set each `baselineSeconds` to a typical
  (not the fastest) run, set `tolerancePercent` from the spread you see
  between those runs, update `source`, and remove `continue-on-error` from the
  "Check test duration budget" step. TODO(measure).

**Why 30%.** Locally, the gap between the first run (cold caches) and the
second (warm) was 30–50%. CI always starts cold, from a fresh checkout with
no Vitest or OS cache, so its run-to-run spread should be much smaller.
That's unmeasured, though, so 30% is a placeholder. Replace it with the
spread observed in CI.

**When a PR legitimately makes the suite slower**, say a large new test file,
update the baseline in the same PR and explain the number in the PR
description, the same way a snapshot diff is explained. When the check fails
and the PR shouldn't have made anything slower, look at the per-suite table
first: one suite jumping while the other stays flat usually points to one
slow new test or a test that now waits on a timeout.

### Rejected: a baseline from the last `main` run

Reading the previous `main` run's timings from the Actions cache or an artifact
would track the runner automatically and never go stale. It was rejected for
now because it needs cross-run artifact lookup and permissions, and because a
cache miss or an expired artifact turns the gate into "no baseline", which is
either a silent pass or a spurious failure. It also lets the baseline drift up
a little each run without anyone deciding that the suite may be slower. A
committed file changes only in a reviewed diff. If keeping it current becomes
a chore, that's the moment to revisit.

## What was changed, and why

### Worker pool: `forks`, at 50% of cores per package

The repository base config (`vitest.config.ts`) now sets `pool: "forks"` and
`maxWorkers: "50%"`.

`pnpm test` runs up to four packages at once, and each package's Vitest starts
its own pool, by default all cores but one. On a 4-thread machine that's up
to 12 forks competing for 4 threads. The run was slower than it needed to be,
and it was **flaky**: a guard test in `@verixa/authorization` timed out at 5s in
every baseline run, and never at 50%.

- **`forks` over `threads`.** Several packages load native code in tests
  (Prisma's query engine, the argon2 addon). A process per worker keeps those
  apart and contains a crash to one worker. `threads` starts faster, but this
  was reasoned about, not measured.
- **A percentage, not a count**, so bigger machines still scale.
- **Rejected: a single Vitest run over all packages** (`vitest.workspace.ts` /
  `projects`, which the roadmap issue names). One shared pool would remove the
  oversubscription outright. But `docs/guides/testing.md` deliberately runs
  each package in its own process, with its own `node_modules` and working
  directory, so that tests resolve dependencies the way the package does at
  runtime. Undoing that is a re-architecture, not a tuning change.
- **Not measured: a cap of 1 worker per package.** It might suit low-memory
  machines. The measurement run was stopped by memory pressure on the test
  machine, and was not repeated.

### `tests/ci/` runs in parallel; `tests/integration/` stays serial

`tests/vitest.config.ts` runs files one at a time because they share one
Postgres. That rule also covered the CI-tooling specs in `tests/ci/`, which
never touch a database: each builds its fixture in its own `mkdtemp`
directory and only reads the real repository. They made up about 87s of the
package's ~176s Vitest time (`sbom.spec.ts` alone took 46s), all serialised for
no reason.

They now run under `tests/vitest.ci.config.ts` with file parallelism, after
the serial integration run (`"test": "vitest run && vitest run --config
vitest.ci.config.ts"`). It's a separate config rather than a Vitest project,
because `fileParallelism` is run-wide in Vitest 3, so one run can't mix serial
and parallel files.

### What stays sequential, and why

- **`tests/integration/`** shares one database. Running it in parallel needs a
  database (or schema) per worker, keyed on `VITEST_POOL_ID`. That's the
  isolation work of Issue 408 (#520), which isn't done. The in-process HTTP
  specs there that don't use the database (about 12s in total) stay serial too:
  splitting them by file would save little and add a third config.
- **The load suite** (`vitest.load.config.ts`) stays serial by design. It
  measures throughput, and parallel files would skew it.

### Testcontainers: unchanged, deliberately

The roadmap asks for one container per run plus reuse across tests. Today
exactly one spec file per package starts a container
(`packages/identity` and `packages/authorization` `database-harness.ts`), so
there is already one container per run. A `globalSetup` would save nothing.

**Cross-run reuse** (`.withReuse()` with `TESTCONTAINERS_REUSE_ENABLE=true`)
skips the container start locally, but it carries database state from one run
into the next. Whether every spec cleans up well enough for that is what
Issue 408 has to establish, so it wasn't added. If it is added later, it
must be a local opt-in only. CI should always start from a fresh database.

## Measurements

All local, on **Windows 10, Intel i3-7100U (2 cores / 4 threads), 6 GB RAM,
Node 22.14.0**, 2 runs per configuration, with `TEST_DATABASE_URL` and
`TEST_REDIS_URL` pointed at a closed port so database-backed tests skip (as on
a fresh clone). Both configurations include this issue's own new spec files.

| Suite       | Before (run 1 / run 2) | After (run 1 / run 2) |
| ----------- | ---------------------- | --------------------- |
| unit        | 296.7s / 216.5s        | 222.6s / 150.6s       |
| integration | 194.0s / 182.3s        | 138.8s / 89.2s        |

- Paired run for run, unit is 25–30% faster.
- The integration "after" run 2 is flattering: a few of the new
  `perf-budget.spec.ts` tests timed out early in that run (since fixed with a
  30s suite timeout, the same as `sbom.spec.ts`). Read it as a lower bound.
- The slowest unit packages after the change (run 2): authorization 62.5s,
  identity 49.8s, mfa 43.3s, sessions 43.2s, audit 32.2s.

**The roadmap's example target, "unit suite under 60s locally", is not met on
this machine.** The unit suite takes 150–223s here. The enforced budget is the
baseline plus tolerance described above. A faster machine will do better, but
that wasn't measured, so this doc doesn't claim a number for it. CI timings:
TODO(measure), from the `test-duration` artifact.

Some runs above also had failures caused by the local machine, not the code.
`undici@8.12.3` needs Node `>=22.19.0`, so the Prisma and Redis repository
specs fail to import on Node 22.14. CI's `node-version: 22` picks up a newer
release.
