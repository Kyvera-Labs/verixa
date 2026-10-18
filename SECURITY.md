# Security Policy

Verixa is authentication, authorization, identity, verification and audit
infrastructure. A bug here is not a cosmetic bug: the code's whole job is to
hold a line, so a defect that lets someone past that line is worth telling us
about before it is worth writing up.

This file describes how to report such a problem, what we will do about it, and
what we consider in scope. It is published **now**, while the project has no
production deployment and no users to protect, for the reason given at the
bottom.

## Supported versions

Verixa is pre-1.0 and distributed as source rather than as released artifacts.
There is no supported-version matrix yet because there is nothing to support:

| Version                                       | Supported                             |
| --------------------------------------------- | ------------------------------------- |
| `master` (the repository's default branch)    | Yes                                   |
| Any fork, tag, or commit that is not `master` | No — reproduce against `master` first |

When Verixa ships tagged releases and a published package, "supported versions"
will mean the two most recent minor lines, and this table will say so.

## Reporting a vulnerability

**Use GitHub's private security advisories.** Open a report at
<https://github.com/Kyvera-Labs/verixa/security/advisories/new>. It is private to
the repository's maintainers and you, it creates a thread we can answer in, and
it becomes a published CVE-ready advisory if we decide a fix warrants one.

Please do not open a public issue, discussion, or pull request for an unfixed
vulnerability, and do not file it as a comment on an unrelated issue. A public
issue is a disclosure the moment it exists, and it puts every deployment of this
code at risk before there is a patch to tell them about.

Email is deliberately not the documented channel. The obvious alternative — a
`security@` address — needs mail infrastructure nobody runs yet, a PGP key whose
revocation story is worse than the one we have, and a mailbox that no on-call
rotation watches. GitHub's advisories give us a shared, access-controlled,
auditable thread with no new secrets to manage, which is a strictly better
channel at this project's size. If you cannot use GitHub, open a normal issue
containing only "I have a security report to make" and stop; a maintainer will
reply with another route.

### What to include

A report that gets acted on quickly usually has:

- **The affected package and file**, e.g. `packages/credentials`, `apps/api`.
  The monorepo is split by context, and "the auth is broken" costs a round trip.
- **A reproduction.** A failing test, a `curl`, or an exact request body. The
  suite is `pnpm test`, and the HTTP routes are exercised end to end under
  `tests/integration/`, so a report that arrives as a test case is one we can
  verify the same day.
- **Impact**: which guarantee fails, and for whom. "An unauthenticated caller
  can learn whether an email is registered" is actionable; "this looks
  insecure" is a conversation.
- **A suggested fix, if you have one** — optional, and never a condition for
  filing. Many good reports have none.

You do not need a working environment to file a report. Reading the code is a
perfectly legitimate way to find a bug.

## What to expect

| Stage          | Commitment                                                                            |
| -------------- | ------------------------------------------------------------------------------------- |
| First response | 7 days to acknowledge, with an initial read on whether we agree it is a vulnerability |
| Triage         | 14 days to a verdict and, if accepted, a severity read                                |
| Fix window     | 90 days from triage to a patch, coordinated with you                                  |
| Credit         | Named in the published advisory, if you want to be                                    |

Those are targets, not a contract, and this project is run by volunteers. If we
are going to miss one we will tell you rather than go quiet — silence is the
failure mode that makes researchers disclose unilaterally, and it is avoidable
by sending one boring email saying "not yet".

If your report is refused, we will say why in as much detail as we safely can.
Plenty of reports turn out to describe intended behaviour, and several of this
repository's security decisions are documented in `docs/security/` precisely so
that a reviewer can find the reasoning instead of having to ask.

## Scope

**In scope:** anything reachable from the code in this repository, in particular
the areas the `docs/security/` directory is about —

- credential handling: registration, login, password reset, account lockout
  (`packages/credentials`)
- token design and storage: email verification, reset tokens, sessions, signing
  keys (`packages/sessions`, `docs/security/token-*.md`)
- multi-tenant data isolation, including Row-Level Security bypasses
  (`packages/identity`, `docs/security/multi-tenancy.md`)
- audit log integrity, including the hash chain and its Stellar anchoring
  (`packages/audit`, `packages/stellar-anchor`)
- authorization policy evaluation (`docs/security/threat-model-abac.md`)
- the HTTP surface in `apps/api`, including its error responses: information
  disclosure over an API is a vulnerability here, because the responses are
  deliberately shaped to say as little as possible
- injection through any raw-query or command-execution path
  (`docs/security/injection-hardening.md`)

**Out of scope, and generally not actionable:**

- Attacks requiring physical access to the database, or to a deployment's secrets
  after someone has already read them. A deployment holding its own
  `DATABASE_URL` and `STELLAR_ANCHOR_SECRET_KEY` is the operator's trust
  boundary, not ours.
- Findings in dependencies with no reachable code path of ours that they enable.
  `pnpm audit --audit-level high` runs in CI on any pull request that changes
  the lockfile; low-severity advisories in transitive dev dependencies are
  accepted knowingly rather than chased.
- Reported weaknesses that the design documents accept on purpose, such as the
  timing trade-offs described in `docs/security/authentication-flows.md`. Point
  at the document, and we will happily argue about it — but "you say you are not
  constant-time" is not a finding.
- Attacks against a deployment configured to be unsafe on purpose, or running
  `infra/postgres/02-init-app-role.sh` in production unchanged.
- Brute forcing of a single user's own password with no other flaw. Lockout and
  rate limiting exist to raise the cost, not to make guessing impossible.

## Disclosure timeline

We follow coordinated disclosure:

1. You send a private report.
2. We confirm or refute within the windows above.
3. The fix lands, and we publish a security advisory — including a CVE if the
   vulnerability warrants one and we can reserve an ID.
4. Public details come with the advisory, or 90 days after we acknowledged the
   report, **whichever is earlier**.

We ask for 90 days before you disclose anything yourself, and we will shorten
that on request as soon as the patch is out. If we have gone unresponsive for
more than 90 days with no patch, you are free to publish; silence from us is not
a reason to keep a live hole quiet.

## If you are hunting bugs in this code

Some constraints that save everyone time:

- Only test against systems you own. There is no hosted Verixa instance to poke;
  anything on the internet that looks like one is not ours.
- `REQUIRE_DATABASE_TESTS=1` and the Docker Compose file in the repository root
  give you the real Postgres-backed suite, which is where the interesting bugs
  in RLS and audit chaining actually show up.
- Automated scanning of third-party infrastructure (GitHub's own endpoints,
  registries) is not part of research on this project.

## Why this file exists so early

Most projects add `SECURITY.md` immediately after their first uncoordinated
disclosure — a public issue that was really a vulnerability, filed by someone
who had no private way to tell the maintainers, at which point the fix and the
announcement happen simultaneously and badly.

Establishing the channel before there is anything to report costs one document
and one route, and buys the ability to receive a report quietly the first time
one arrives. That is the entire argument, and it is also why
`/.well-known/security.txt` (RFC 9116) is served by the API: it is the path an
automated scanner or a researcher looks for first, and it costs nothing to have
an answer there.
