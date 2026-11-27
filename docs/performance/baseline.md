# Persistence Performance Baseline

Recorded with `pnpm db:benchmark` (Issue 059). This exists so Phase 23 has a
number to compare against rather than an argument about whether things were
always like this.

## How to record one

```bash
docker compose up -d postgres
pnpm --filter @verixa/database run db:migrate:deploy
pnpm db:benchmark
```

200 iterations per operation, 20 discarded warm-up runs. Warm-up is discarded
because the first calls pay for connection setup, Prisma's query-engine
startup, and a cold buffer cache — real costs, but one-off ones that would
otherwise dominate `max` and distort p95.

## These numbers are not a target, and not portable

A baseline is only meaningful **compared against itself, on the same
hardware, measured the same way.**

Latency here is dominated by the round trip to Postgres. A local container, a
shared CI runner, and a production instance across a network differ by an
order of magnitude for reasons that have nothing to do with the code. Numbers
recorded on one and compared against another say nothing at all.

So: record your own before optimizing anything, and compare like with like.
Treating the table below as a pass/fail threshold would be a misreading.

## Why p50 _and_ p95

A mean hides the tail, and the tail is what users experience as "slow". One
request in twenty taking 400ms is a real problem that a 12ms average conceals
entirely.

- **p50** — what a typical request costs.
- **p95** — what a bad one costs.

Both are reported because improving one at the other's expense is a common
and otherwise invisible mistake. A change that halves the median while
doubling the tail has usually made things worse.

## Baseline

| Operation                      |           p50 (ms) | p95 (ms) | p99 (ms) |
| ------------------------------ | -----------------: | -------: | -------: |
| `UserRepository.save` (insert) | _not yet recorded_ |          |          |
| `UserRepository.findById`      | _not yet recorded_ |          |          |
| `UserRepository.findByEmail`   | _not yet recorded_ |          |          |
| `UserRepository.existsByEmail` | _not yet recorded_ |          |          |
| `UserRepository.save` (update) | _not yet recorded_ |          |          |

**Environment:** _to be filled in when recorded — CPU, RAM, Postgres version,
whether the database is containerized, and whether it is local or remote._

This table is deliberately empty rather than populated from the CI runner.
Publishing shared-runner numbers as "the baseline" would invite exactly the
cross-machine comparison the section above says is meaningless — and a wrong
number carries more authority than a missing one. Fill it in from a machine
you will actually measure against later.

## What to expect, roughly

Not measurements — just the shape of the thing, so an obviously wrong result
is recognizable:

- Indexed single-row lookups (`findById`, `findByEmail`) should be
  dominated by network round trip, not query execution. On a local container
  that usually means low single-digit milliseconds.
- `existsByEmail` should be at or below `findByEmail`: it selects one column
  and skips reconstructing an aggregate.
- Writes cost more than reads, and are subject to `fsync` on commit.
- A p95 many multiples of p50 on a quiet machine suggests connection-pool
  contention or a GC pause, not slow SQL.

If a lookup lands in the tens of milliseconds locally, suspect a missing
index before suspecting the ORM — `tests/integration/index-usage.spec.ts`
asserts the expected plans.
