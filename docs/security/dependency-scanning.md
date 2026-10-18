# Dependency Scanning

Most real-world breaches use a vulnerability that was already patched somewhere.
The attack is rarely novel: it is a package version that was current when it was
added, an advisory published last week, and nobody watching the graph shuffle
underneath them.

Roadmap Issue 207. Workflow: `.github/workflows/dependency-scan.yml`. Gate:
`infra/ci/dependency-scan.mjs`. Exception file:
`infra/ci/security-exceptions.json`.

## What runs, and when

The `Dependency scan` workflow runs:

- on every **pull request**, so a newly added dependency with a known high or
  critical advisory fails before it is merged;
- on every push to **`main`**, so the post-merge state is checked;
- on a **nightly schedule** off the hour (`23 3 * * *`), because advisories are
  published by other people on their schedule. A dependency that passed on
  Monday can fail on Tuesday with no change to this repository, and the
  scheduled run is the only thing that notices without someone remembering to
  look;
- on **manual dispatch**, for the case where a maintainer wants the answer now.

The report is uploaded as the `dependency-audit` artifact on every run,
including passing ones. When the nightly build fails, the report is the
evidence for what it looked at.

## Scope: production dependencies

The workflow audits with `pnpm audit --prod`. A high advisory in a build tool
is a real finding, but it is not shipped, and blocking every pull request on the
dev-dependency graph is how a security gate becomes something people route
around. The production graph is the one with a customer on the other end of it.

The install that precedes the audit uses `--frozen-lockfile`, so the audit
describes the graph this repository actually ships. Auditing a freshly resolved
graph would report on versions nobody reviewed — the lockfile-integrity gate
(Issue 215) is what keeps that graph honest.

## Why the gate is a script, not `--audit-level`

`pnpm audit --audit-level=high` already exits non-zero on a high or critical
advisory, and it was the first implementation considered. It cannot express the
exception process this issue requires: a maintainer who has reviewed an
advisory and decided a fix is not available yet has no way to say so except to
stop auditing the graph entirely.

`infra/ci/dependency-scan.mjs` reads the report, applies a maintained list of
accepted risks, and fails on everything else. That turns "we know about this
one" from an unrecorded decision into a dated entry that comes back up for
review. It also makes the behaviour testable against captured reports —
including the two cases that matter most, an exception that covers a finding
and one that has expired.

## Exceptions

```json
{
  "exceptions": [
    {
      "advisory": "GHSA-vh95-rmgr-6w4m",
      "package": "minimist",
      "justification": "Prototype pollution; the vulnerable path is unreachable in this deployment.",
      "reviewedOn": "2026-10-01",
      "expiresOn": "2026-12-31"
    }
  ]
}
```

| Field           | Required | Meaning                                                                                  |
| --------------- | -------- | ---------------------------------------------------------------------------------------- |
| `advisory`      | yes      | A GHSA or CVE identifier, or `npm:<id>` when only the registry id exists.                |
| `package`       | yes      | The affected package name; an exception covers one package.                              |
| `justification` | yes      | Why this is acceptable. A reviewer has to be able to disagree with it.                   |
| `reviewedOn`    | yes      | When the decision was made.                                                              |
| `expiresOn`     | yes      | When it stops applying. On the date itself it still applies; the day after, it does not. |

Rules the gate enforces:

- An exception with a missing field, an empty justification, or a non-date
  range **fails the job with exit 2**, not 1. A malformed exceptions file must
  never look like a vulnerability, and a vulnerability must never look like a
  typo.
- An **expired** exception is treated as absent. The finding returns to the
  failure list and the message says which exception expired. If expiry were
  advisory, the review date would be decorative.
- Matching is exact on the package and **case-insensitive** on the advisory id.
  It is deliberately not a wildcard: an exception that could cover future
  advisories in a package is a standing permission, which is the opposite of
  what a review date means.

The identifier to use is the one the failing job prints. That is why the
message includes every identifier the report carries — the GHSA id, the CVE,
and the npm registry id when GitHub has not published a GHSA.

## Review process

1. The gate fails and prints the package, severity, affected range and
   identifiers.
2. The reviewer answers one question: **is the vulnerable code path reachable in
   any supported deployment?** "No" requires a sentence explaining why — not
   reachable at runtime, the input is validated before it reaches the library,
   the affected API is unused.
3. If the answer is yes, upgrade or replace the dependency. An exception for a
   reachable vulnerability is not an accepted risk, it is an unhandled one.
4. Otherwise, add an entry with a review date no more than **90 days** out. The
   date is a prompt to re-check for a fix, not a deadline that is extended
   automatically.

There is no `no-expiry` value and no placeholder. A file that accepts one is a
file where the first entry is permanent.

## Local use

```bash
pnpm audit --prod --json > dependency-audit.json || true
node infra/ci/dependency-scan.mjs \
  --audit dependency-audit.json \
  --exceptions infra/ci/security-exceptions.json
```

`--today YYYY-MM-DD` overrides the clock for testing an expiry boundary. The
script exits `0` when nothing serious is unexcepted, `1` when something is, and
`2` when an input could not be read or is malformed.

## Testing

`tests/ci/dependency-scan.spec.ts` runs the gate as a subprocess against
captured reports in `infra/ci/fixtures/dependency-scan/`. The fixture manifest
pins two intentionally vulnerable production dependencies; the reports are what
`pnpm audit --prod --json` emitted for them. The cases cover:

- the gate fires on high and critical findings and names them;
- moderate findings do not fail the build;
- an unexpired exception covers a finding, and an expired one does not;
- an exception for one advisory does not cover another in the same package;
- both audit report shapes (`vulnerabilities` and the older `advisories` map);
- exit code 2 for a malformed exceptions file, an unrecognized report, a
  missing report, and a usage error;
- the workflow is wired to pull requests, a nightly schedule, and the
  exceptions file.

Captured reports rather than a live `pnpm audit`: a test that reaches the
registry fails when the network does, and reports on vulnerabilities published
since it was written instead of on the gate's behaviour.

## What is deliberately not here

- **Automatic dependency upgrades.** Dependabot or Renovate can open the pull
  request; deciding whether an upgrade is safe is a review, not a bot action.
  A bot that rewrites the lockfile weekly is a supply-chain surface of its own.
- **A second scanner.** The issue names `osv-scanner` as an option alongside
  `npm audit`. One scanner whose output is understood, with a documented
  exception process, beats two whose findings disagree — and the audit protocol
  is what pnpm and npm both emit. If OSV is added later, it should feed the same
  exceptions file rather than introduce a second list.
- **Scanning the dev-dependency graph for blocking.** See "Scope" above. The
  `container-scan` workflow (Issue 216) reports the full image inventory
  separately.
- **Failing on low and moderate advisories.** A gate that is red most of the
  time is not a gate. They still appear in the report artifact.
