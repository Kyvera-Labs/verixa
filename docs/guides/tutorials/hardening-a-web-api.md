# Hardening a Web API: defense in depth, one boundary at a time

This tutorial explains how to reason about hardening a Fastify API like
Verixa. It starts with a small HTTP service and adds controls at the layers
where they belong. Each control blocks a different failure mode; none makes an
untrusted request safe by itself.

The examples use this repository's actual boundaries: `apps/api/src/app.ts`
constructs Fastify, `packages/config` validates configuration,
`packages/credentials` owns authentication rules, and CI installs from the
pinned `pnpm-lock.yaml`. Some controls described below are planned rather than
implemented in the current API. They are labeled so a reader does not mistake
an example for a production guarantee. There is no checked-in staging
penetration-test report at this revision, so the examples below are threat
model and code-review findings, not claims that a test was run.

## 1. Start with a request path

A request crosses several trust boundaries:

1. A browser or machine client chooses an origin and constructs a request.
2. A proxy terminates TLS and forwards it to the Fastify process.
3. Fastify parses and validates the request shape.
4. A route calls an application use case.
5. The use case enforces domain rules and calls ports implemented by adapters.
6. The response and logs leave the process through different sinks.

A secure design puts each check at the boundary that has the information to
make it. A browser policy cannot replace authorization in a use case. A route
schema cannot decide whether a user may act on a particular tenant. A log
redactor cannot make intentionally logging a password acceptable.

## 2. Add response headers for browser-facing risks

Headers reduce browser behavior that can turn an otherwise harmless response
into an exploit. For example, `X-Content-Type-Options: nosniff` prevents MIME
sniffing; `X-Frame-Options` or CSP `frame-ancestors` helps stop clickjacking;
`Referrer-Policy` limits information sent to another site. HSTS only helps
when the deployment is actually served over HTTPS and should be configured at
the TLS boundary with an appropriate rollout plan.

A real Fastify implementation belongs in a plugin registered once in
`buildApp`, before route registration. The Phase 11 design calls for
`@fastify/helmet` and a tested global policy. Until that plugin is present,
these are requirements for the deployment edge, not headers this application
can promise. Do not copy a strict Content Security Policy blindly: an API that
serves no HTML gains little from browser script policy, while a UI may break
if its legitimate script sources are omitted.

**Threat-model finding:** a missing global header plugin means the response
policy can vary by route or proxy. The fix is centralized registration and an
integration assertion over a representative route, not repeating header
calls in handlers.

## 3. Treat CORS as an explicit browser permission

CORS tells browsers which origins may read a response. It does not authenticate
a caller, and non-browser clients do not enforce it. A narrow allowlist should
come from validated deployment configuration. If credentials are allowed,
never combine them with `Access-Control-Allow-Origin: *`; reflect only an
origin that exactly matches the allowlist and set `Vary: Origin` where needed.

The Phase 11 implementation target is `@fastify/cors` configured from
`packages/config`, with startup failure for wildcard-plus-credentials. Until
that work lands, do not describe CORS as an authorization control. Keep
sensitive routes same-origin or block cross-origin access at the deployment
edge, then still authenticate and authorize every request server-side.

A useful review asks: which browser UI origins need access, which methods and
headers are needed, and why are credentials required? If the answer is not
clear, the safer default is no cross-origin access.

## 4. Decide whether CSRF applies to the authentication mechanism

Browsers attach cookies automatically, which creates CSRF risk for
cookie-authenticated state-changing requests. A synchronizer token or
properly-bound double-submit token can prove that the browser's request came
from the application flow. SameSite cookie attributes add another layer; they
do not replace server-side checks.

A bearer token explicitly added by application code is not normally attached
by a hostile site, so the same CSRF mechanism is not appropriate for every
machine API request. This distinction changes if the bearer credential is
stored in a cookie. The Phase 11 plan scopes CSRF protection to cookie-backed
sessions and leaves bearer/API-key clients unaffected. This repository should
not claim cookie-CSRF protection until cookie session issuance and the
corresponding Fastify hook are actually wired and tested.

**Threat-model finding:** adding CORS alone does not solve CSRF. CORS mainly
controls whether a browser can read a response; a cross-site form may still
send a request. Select the policy from the credential transport, not from the
route name.

## 5. Keep secrets out of source, logs, and responses

Configuration is a trust boundary. Read secrets from the deployment's secret
store or protected environment, validate required values at startup, and fail
closed when a signing key is missing. Never commit a real `.env`, print
credentials during startup, or use a production secret as a test fixture.

Verixa's `packages/config` parses security-sensitive settings, while the
composition root refuses selected unsafe signing configurations. The shared
logger redacts common secret-shaped fields, but redaction is only a backstop:
application code must not deliberately log passwords, cookies, access tokens,
refresh tokens, API keys, or private keys. See
[`docs/guides/configuration.md`](../configuration.md),
[`docs/guides/logging.md`](../logging.md), and
[`docs/security/stellar-key-management.md`](../../security/stellar-key-management.md).

If a secret leaks, deleting the line or rewriting Git history does not revoke
it. Revoke it at the issuer, issue a replacement, update consumers, verify
the previous value is rejected, and then clean up the exposed copy. Record the exposure and response in the
project's private security-reporting channel, and notify affected deployment
owners.

## 6. Make dependency updates reviewable

A lockfile makes dependency resolution reproducible; it does not guarantee
that a package is safe. CI should install from the lockfile, run the project's
checks, and scan direct and transitive dependencies for known advisories. A
finding needs an owner and response window. An automatic update is not
complete until compatibility and the resulting lockfile are reviewed.

For this workspace, use `pnpm install --frozen-lockfile` in CI and inspect
changes to `pnpm-lock.yaml` alongside `package.json`. Do not run a broad update
to address one vulnerable package unless the resulting upgrade set is
understood. The Phase 19 pipeline specification tracks automated dependency
scanning; a local lockfile alone is not evidence that the scan ran.

**Threat-model finding:** an unreviewed transitive update can change code that
runs in the API process even when Verixa's own source is unchanged. Pinning and
scanning reduce different parts of that risk; code review and a release plan
still matter.

## 7. Stop brute-force abuse without locking out users

Authentication needs both a correct credential check and a limit on how often
an attacker can attempt it. Account lockout reduces repeated guesses against
one account, but an attacker can abuse it to deny service to a victim. A
network-only limit is also insufficient against distributed attempts.

A production policy usually combines per-account and per-source limits,
progressive delays or bounded lockout, monitoring, and a recovery path. Avoid
revealing whether an email address exists. When limits are shared across API
instances, use a shared store rather than an in-memory counter that resets on
each deployment.

In Verixa, credential use cases expose a rate-limiter port, but the composition
root currently wires `NoopRateLimiter`. That is deliberately visible and is
not an effective production limit. The operational finding is therefore
**open** until Phase 15 supplies and configures a real adapter. Put temporary
limits at a trusted gateway if deploying before then, and monitor both abuse
and false positives. Never claim the application itself stops brute force
while the no-op adapter is wired.

## 8. Verify the complete boundary

For each control, verify both the allowed and denied path:

- Headers appear on normal, error, and not-found responses.
- An allowlisted browser origin receives only the required CORS permissions;
  a different origin does not.
- Cookie-authenticated state changes reject missing or invalid CSRF tokens;
  bearer-authenticated clients follow the documented separate path.
- Startup fails for absent or unsafe security configuration, and logs and
  responses do not contain secret values.
- CI installs the locked dependency graph and reports vulnerabilities with an
  owner and response process.
- Login limits hold across multiple API instances without turning a single
  attacker's requests into permanent victim lockout.

A control that has no negative test or operational evidence is an assumption,
not a verified defense. Record each gap in the relevant Phase 11 or Phase 15
work item, assign an owner, and update the threat model when the behavior
changes.

## Further reading

- [`docs/security/threat-register.md`](../../security/threat-register.md)
- [`docs/security/authentication-flows.md`](../../security/authentication-flows.md)
- [`docs/security/threat-register.md`](../../security/threat-register.md)
- [`planning/issues/phase-11-security-hardening.md`](../../../planning/issues/phase-11-security-hardening.md)
- [`planning/issues/phase-15-rate-limiting.md`](../../../planning/issues/phase-15-rate-limiting.md)
- [`planning/issues/phase-19-cicd-automation.md`](../../../planning/issues/phase-19-cicd-automation.md)
