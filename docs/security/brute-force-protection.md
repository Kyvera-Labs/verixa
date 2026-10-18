# Brute-force protection

Issue 209. The policy lives in `packages/shared-kernel`, the two wired call
sites live in `packages/credentials`, and the composition root in `apps/api`
decides whether a gate exists at all.

## The problem the existing lockout does not cover

`Credential.recordFailedAttempt` already counts consecutive failures and locks
the row when it reaches the threshold (Issue 067). That is the right mechanism
for a _known_ account, and it stays load-bearing. It has three blind spots, and
they are the three an attacker actually selects for:

| Attempt                                                      | Why the row counter cannot see it                                                                                    |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| A probe against an address with no account                   | There is no row to advance. An enumeration run over a stolen user list is completely unthrottled.                    |
| An account with no password credential (SSO or passkey only) | Same: `findByUserId` returns nothing, so nothing counts.                                                             |
| Password spraying                                            | One common password against thousands of accounts, one attempt each — permanently below every per-account threshold. |

The gate added here counts failures per **scope + identifier** in a store of its
own, so the first two accumulate and the third is at least visible per target.

## What is wired

Both call sites take the policy as an **optional, last** constructor argument.
Existing callers construct these use cases without it and behave exactly as
before; the composition root supplies one instance shared by both.

| Call site                                                                          | Scope key                       | Checked                                               | Recorded as a failure                       | Recorded as a success  |
| ---------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------- | ------------------------------------------- | ---------------------- |
| `POST /auth/login` → `AuthenticateWithPassword`                                    | `login:<email>`                 | before the email is parsed and before any row is read | the no-user and no-credential branches only | a confirmed login      |
| `ConfirmPasswordReset` (the use case; no HTTP route exists for it yet — see below) | `password-reset:<token digest>` | after password validation, before the token lookup    | every invalid-token outcome                 | a valid token consumed |

The reset side deserves a plain statement rather than a checkbox: `apps/api`
routes registration and login, and the password-reset flow is reachable today
only through the container (`tests/integration/verification-tokens.spec.ts`
exercises it that way). The gate is wired into the use case, so it is in place
when the route is, and it protects nothing that is not yet exposed. Writing
"reset endpoint protected" would have been the kind of claim this document is
elsewhere careful not to make.

Two choices in that table are deliberate and are the ones a reviewer should
check first:

- **A wrong password on an existing account is not counted here.** It is already
  counted durably, on the row, by the aggregate. Counting it in two places gives
  one failure two penalties and makes the effective threshold impossible to
  state. The gate covers exactly what the row cannot see.
- **A refusal looks like every other failed login.** For login that means
  `401`, `AUTHENTICATION_FAILED`, the message `Invalid email or password.`, no
  `Retry-After`, and the decoy argon2 verification still runs. Refusing faster
  or louder would answer "does this address exist", which is the leak the rest
  of `AuthenticateWithPassword` is built to close. The throttled path therefore
  still costs a hash: the saving is the database read, not the CPU.

The reset budget is keyed on the token's **digest**, not the token, because the
digest is what the lookup uses and is safe to hold in memory and to log.

## Composing with a request-rate limiter

A limiter counts requests; this counts failures. Checking both is required, not
optional, and the reason is arithmetic: a limiter allowing 10 requests a minute
beside a policy with a threshold of 5 would let a burst through if either gate
were consulted alone. `BruteForcePolicy.check` asks the limiter (when one is
supplied) and the attempt store, allows only if both allow, and reports which
refused in `source` — for logs and tests, never in a response body, because
"you were refused by the IP limiter" tells the caller which resource to rotate.

When both refuse, `retryAfterSeconds` is the **longer** of the two. Reporting the
shorter produces a retry loop that is refused again for the remaining seconds.

`check` never records anything. A refusal that also incremented the counter would
let an attacker already in lockout lengthen their own lock by retrying, which is
the opposite of what the counter measures.

`RateLimiter` (`packages/shared-kernel/application/ports/rate-limiter.ts`) is
declared as an interface only. Issue 074 owns the implementation and Phase 15
supplies it; the port exists here so that composing the two gates is a wiring
change rather than a redesign.

## Thresholds

`DEFAULT_BRUTE_FORCE_THRESHOLDS` is `{ threshold: 5, base: 60s, factor: 2,
max: 1h }` — the same numbers as `DEFAULT_LOCKOUT_POLICY`. There is a test
asserting the literals for exactly that reason: two counters guarding one login
flow with different thresholds means the effective policy is whichever is
looser, silently.

The duration doubles per failure past the threshold and is capped before the
multiplication. The cap matters twice over: it stops a runaway counter producing
`Infinity` (an Invalid `Date`, which a store persists as "never locked" — the
bug is documented in `credentials`' lockout code and mirrored here), and it keeps
lockout a speed bump for the attacker rather than a weapon against the account
holder, since anyone who knows an address can otherwise lock its owner out
indefinitely.

## Scopes declared but not wired

`mfa` and `api-key` are in the `BruteForceScope` union and covered by key
derivation and budget-isolation tests, and **no endpoint consults them yet**.

- **MFA**: the challenge endpoint lives in `packages/mfa`, which does not
  compile in this repository at the time of writing (`token-signer.ts` and
  `in-memory-revocation-list.ts` have syntax errors, and its `tsconfig.json`
  cannot be parsed). Wiring a gate into a package that cannot be built is not
  possible here, and pretending otherwise in a checklist would be worse than
  stating the gap. When that package is repaired, `BruteForcePolicy` takes the
  `"mfa"` scope with no changes to its code.
- **API keys**: no API-key auth path exists yet.

The scopes are declared now so that adopting them later is a call-site change.
A union rather than a free string is deliberate: an unrecognised scope would
silently create its own bucket, so a typo would look like it worked while
protecting nothing.

## What this is not, yet

Stated plainly, because a half-measure described as a defence is how a deployment
ends up believing it has one:

- **Process-local and volatile.** `InMemoryBruteForceAttemptStore` is a `Map`. A
  restart clears every counter, and each API replica keeps its own. Phase 15
  replaces it with a durable store behind the same port; nothing above changes.
- **Per-identifier, not per-IP or per-device.** The device and session scopes
  Issue 209 also names belong to Phase 05 (sessions) and Phase 04 (devices),
  which are not built yet, and to the limiter that owns IP-keyed budget.
- **An approximation of an identity.** Keys are trimmed and lowercased, which is
  enough that the same attacker typing the same address does not get a fresh
  budget for each spelling mistake. It is deliberately not address
  canonicalisation — local parts differ in ways this code must not guess at,
  since merging two people's budgets is a worse failure than letting one
  attacker get a few extra guesses.
- **Not a lockout.** Nothing here writes `Credential.lockedUntil`. The row remains
  the only durable statement that an account is locked.

## Tests

- `packages/shared-kernel/application/services/brute-force-policy.spec.ts` — key
  derivation for all four scopes, budget isolation between them, threshold and
  exponential backoff, the cap and the `Infinity` case, window expiry clearing
  the counter, success clearing, `check` being read-only, and the four limiter
  compositions (both allow, limiter alone, both refuse with the longer wait, a
  limiter with no retry window).
- `packages/credentials/application/use-cases/brute-force-wiring.spec.ts` — the
  enumeration branch accumulates and then refuses without reaching the database,
  the refusal is indistinguishable in code and message, a wrong password on a
  real account does **not** move the shared budget, one exhausted budget leaves
  other accounts usable, and the reset gate counts token guesses but not a
  password that fails policy validation first.
- `packages/credentials/application/use-cases/authenticate-with-password*.spec.ts`
  and `password-reset.spec.ts` pass unchanged, which is the regression guard for
  the optional-collaborator shape.
