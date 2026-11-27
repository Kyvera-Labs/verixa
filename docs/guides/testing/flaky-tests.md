# Flaky Test Detection & Quarantine Policy

This guide defines the engineering conventions, automated retry mechanics, and time-boxed `@quarantine` process for managing non-deterministic tests in Verixa (Issue 414).

---

## 1. Why Flaky Tests Compound Debt

A **flaky test** is a test that exhibits both passing and failing results across repeated runs with zero code changes (often caused by concurrency race conditions, resource starvation, unseeded PRNGs, wall-clock timing jitter, or shared database state).

> _"Flaky tests are a form of technical debt with compounding interest — each one that goes unmanaged reduces the signal value of every other test in the suite, since 'just rerun it' becomes muscle memory for real failures too."_

When contributors perceive CI as unreliable:

1. Real regressions get dismissed as "probably just that one flaky test" and merged into `main`.
2. Confidence in refactoring collapses.
3. Developers spend time re-running jobs instead of writing features.

Verixa treats test stability as a first-class production requirement.

---

## 2. Retry Mechanics & Classification Lifecycle

Verixa uses an automated classification model implemented in `infra/ci/flaky-test-tracker.ts`:

```
Attempt 1 (Initial Run)
  ├── PASS ───────────────────────────────────────────> [STABLE]
  └── FAIL
        ├── Attempt 2 (Retry 1) ── PASS ──────────────> [FLAKY (Tracked)]
        └── FAIL
              ├── Attempt 3 (Retry 2) ── PASS ────────> [FLAKY (Tracked)]
              └── FAIL ───────────────────────────────> [FAILING (CI Red)]
```

### Classification Categories

1. **`stable`**: Test passes on the first attempt. No action required.
2. **`flaky`**: Test fails on attempt 1, but passes within configured retry attempts (e.g. `maxRetries = 2`).
   - The test run **passes** to prevent blocking a clean commit.
   - The test is **auto-recorded** in `infra/ci/flaky-tests-ledger.json` and reported in the CI step summary table with its retry attempt number and error trace.
3. **`failing`**: Test fails all attempts. This is classified as a deterministic defect; CI exits with code 1.

---

## 3. The `@quarantine` Convention

When an integration or E2E test is identified as intermittently flaky and cannot be immediately resolved, it may be placed into **quarantine** rather than deleted or commented out.

### Syntax

Add the `@quarantine` annotation to the test title or description:

```ts
it.skip('@quarantine(until=2026-12-15, reason="Redis connection timeout under worker pool saturation", issue="#420", owner="@modric")', async () => {
  // Test implementation remains intact and compiles cleanly
});
```

### Mandatory Fields

- **`until=YYYY-MM-DD`**: The hard expiration date (maximum 14 days from quarantine date).
- **`reason="..."`**: A concise explanation of the observed non-determinism.
- **`issue="#<id>"`**: The tracked GitHub issue assigned to investigate and fix the root cause.
- **`owner="@handle"`** _(optional)_: The engineer responsible for resolving or driving the fix.

---

## 4. Time-Boxing & Hard Expiration Gate

Unchecked test skipping is a common anti-pattern where tests are disabled and forgotten permanently.

To eliminate this:

1. **Automated CI Expiration Audit**: CI runs `pnpm flaky:track --scan-quarantines` on every pull request and push to `main`.
2. **Hard Failure on Expiration**: When current date > `until`:
   - Quarantine status becomes **`EXPIRED`**.
   - `shouldSkip` is set to `false`.
   - CI exits with code 1.
3. **Resolution Required**: The PR author or maintainer must either:
   - Land the bug fix and remove the `@quarantine` tag.
   - Or formally extend the quarantine date with a documented comment on the linked tracking issue explaining the block.

---

## 5. Local CLI Commands

```bash
# Scan all packages and test directories for active and expired quarantines
pnpm flaky:track --scan-quarantines

# Process a Vitest JSON report and record flakiness occurrences
pnpm flaky:track --report test-results.json --output-markdown flaky-summary.md

# Inspect the tracked flaky tests ledger
cat infra/ci/flaky-tests-ledger.json
```

---

## 6. Design Decisions & Alternatives Rejected

1. **Silent Retries (Vitest `retry` alone without tracking):**
   - _Rejected:_ Masking failures with retries without logging makes the test suite progressively slower as retries silently accumulate, and leaves intermittent bugs in production code undiscovered.
   - _Chosen:_ Retries prevent immediate blocker friction, but `flaky-test-tracker.ts` surfaces every flake visibly in CI markdown summaries and tracking ledgers.

2. **Deleting Flaky Tests:**
   - _Rejected:_ Deleting a flaky test deletes the specification of intended behavior and opens the door for silent regressions in the code it was guarding.
   - _Chosen:_ Time-boxed quarantine preserves the test code and type-checking while enforcing a strict timeline for remediation.
