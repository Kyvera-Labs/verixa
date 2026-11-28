# Workspace Coverage Aggregation & Ratchet Gate

This guide documents the monorepo-wide test coverage strategy in Verixa, detailing the aggregation pipeline (Issue 412) and the coverage threshold ratchet (Issue 413).

---

## 1. Context & Philosophy

Verixa consists of independent bounded contexts (such as `@verixa/identity`, `@verixa/sessions`, `@verixa/credentials`, `@verixa/audit`, `@verixa/verification`), applications (`@verixa/api`), and cross-package testing harnesses (`@verixa/integration-tests`).

### Per-Package Floors vs. Monorepo Aggregate

Under Phase 02 (Issue 037), individual packages established isolated coverage floors in their respective `vitest.config.ts`. Per-package gates answer the question:

> _"Is this specific package well-tested in isolation?"_

However, per-package gates have blind spots:

1. **Uneven Quality Profiles:** Packages meeting their local floor might still sit significantly below platform norms without visibility.
2. **Missing Monorepo Overview:** Maintainers reviewing PRs had to inspect disparate CI step logs to evaluate overall codebase health.
3. **Integration Gaps:** Cross-package integration suites (`tests/`) test multi-context flows that touch code paths across boundaries.

The workspace-wide coverage pipeline answers:

> _"Is the platform as a whole well-tested, and are we improving over time without backsliding?"_

---

## 2. Workspace Coverage Architecture

Coverage aggregation is orchestrated by two tools:

- **`vitest.workspace.ts`**: The Vitest workspace configuration defining project boundaries across `apps/*`, `packages/*`, and `tests/*`.
- **`infra/ci/coverage-merge.ts`**: Standalone TypeScript tool that traverses package coverage directories, parses V8/LCOV outputs, aggregates statement, line, function, and branch metrics, and produces:
  - `coverage/coverage-summary.json` (canonical JSON metrics)
  - `coverage/lcov.info` (merged LCOV file for tooling consumption)
  - `coverage/index.html` (interactive HTML dashboard)
  - `coverage/summary.md` (GitHub step summary and PR breakdown)

### Running Coverage Locally

To generate coverage for all packages and assemble the merged report:

```bash
# Run all package test suites with coverage and merge results
pnpm test:workspace:coverage

# Or merge pre-existing coverage reports
pnpm test:coverage:merge
```

The resulting dashboard is viewable at `coverage/index.html`.

---

## 3. The Coverage Ratchet

A single global threshold (e.g., "85% across everything") creates an all-or-nothing dilemma: it either penalizes early-phase or scaffolded packages unfairly or allows well-tested packages to shed coverage unnoticed.

The **Coverage Ratchet** (`infra/ci/coverage-ratchet.ts`) enforces an incremental improvement contract:

- **Never get worse:** A PR cannot drop coverage below the recorded baseline on `main`.
- **Get better sustainably:** When new tests increase coverage, the baseline raises automatically on merge to `main`.

### The Baseline File (`infra/ci/coverage-baseline.json`)

The baseline is a checked-in JSON record tracking aggregate and per-package numbers:

```json
{
  "version": 1,
  "updatedAt": "2026-11-19T17:00:00.000Z",
  "tolerance": 0.1,
  "aggregate": {
    "lines": 85.0,
    "statements": 85.0,
    "functions": 80.0,
    "branches": 75.0
  },
  "packages": {
    "@verixa/identity": { "lines": 90.0, "statements": 90.0, "functions": 85.0, "branches": 85.0 },
    ...
  }
}
```

### Tolerance Margin (`±0.1%`)

Code churn (e.g. formatting comments, refactoring boilerplate, or deleting dead code) can cause micro-fluctuations in metric percentages. The ratchet includes a configurable `--tolerance` (default `0.1%`). A drop smaller than `0.1%` is categorized as `maintained`, preventing false-positive CI failures.

### Execution

```bash
# Verify coverage against baseline
pnpm coverage:ratchet

# Custom tolerance check
pnpm coverage:ratchet --tolerance 0.2

# Update baseline file with improved metrics
pnpm coverage:ratchet --update-baseline
```

---

## 4. Temporary Override Procedure

Occasionally, an architectural refactor legitimately reduces statement counts or temporarily shifts coverage before follow-up tests land (for example, deprecating an adapter or splitting a package).

To prevent blocking critical fixes, maintainers may bypass the ratchet gate:

### Via Environment Variable (CI)

In GitHub Actions, trigger the workflow or set the environment variable:

```bash
COVERAGE_RATCHET_OVERRIDE="Refactoring session storage adapters (see issue #420)"
```

### Via CLI Flag (Local / Scripts)

```bash
pnpm coverage:ratchet --allow-drop --override-reason "Deprecating legacy token format"
```

> **Policy:** Any ratchet override must be accompanied by an explicit reason linking to a tracked GitHub issue. CI highlights overrides with a `Coverage ratchet override applied` banner in the PR step summary.

---

## 5. Architectural Decisions & Alternatives Rejected

1. **In-Tree Tooling vs. Third-Party SaaS (e.g. Codecov, Coveralls):**
   - _Chosen:_ In-tree pure TypeScript scripts (`coverage-merge.ts`, `coverage-ratchet.ts`) using standard Node.js APIs and V8/LCOV outputs.
   - _Reason:_ Third-party SaaS introduces network flakiness, secret token management, and vendor lock-in. In-tree scripts run identically on developer laptops and in CI without internet dependencies.

2. **Monolithic Global Threshold vs. Dynamic Ratchet:**
   - _Chosen:_ Incremental ratchet comparing against checked-in `coverage-baseline.json`.
   - _Reason:_ A monolithic threshold disincentivizes adding large, partially covered feature branches or penalizes high-rigor packages when lower-rigor modules are added. The ratchet guarantees monotonic progress without artificial friction.
