# Penetration-Test Checklist

Automated scanning tells you what is _known to be broken_. It cannot tell you
that the reviewer check is `authorization.includes("reviewer")`, that an
approval endpoint trusts a header an attacker types, or that a business flow
lets anyone submit a KYC request for someone else's organization. Those are
**logic** problems, and they are only findable by someone who reads the
roadmap, understands what the endpoint is _for_, and then tries to use it
without being allowed to.

So the rule:

**Every release gets an adversarial pass over this checklist, run by a human
against a live instance, and every finding — including the ones that turn out
to be fine — is written down with a severity.**

Roadmap Issue 217. This file is the checklist; [pen-test-findings-2026.md](./pen-test-findings-2026.md)
is the first exercise run against it. Categories and IDs follow the [OWASP Web
Security Testing Guide v4.2](https://owasp.org/www-project-web-security-testing-guide/).

## What this is not

| Concern                              | Owned by                                   |
| ------------------------------------ | ------------------------------------------ |
| Dependency and OS advisories         | Issues 207, 208, 215; `container-scan.yml` |
| Static analysis / dangerous patterns | Issue 208 (`eslint-plugin-security`)       |
| Structural threat modeling           | Issue 201, the `threat-model-*.md` set     |
| ASVS requirement coverage            | Issue 219                                  |
| What to do _during_ an incident      | Issue 218                                  |

This checklist is the only place where the question is "can I, a specific
unauthorized person, make this system do the thing it should refuse?"

## Rules of engagement

Written down because Issue 217's exercise is the kind of testing an open-source
project must be able to repeat without anyone guessing at the boundaries.

- **In scope:** the HTTP surface of `apps/api` — every route `buildApp`
  registers, its request parsing, its guards, its error paths, and the response
  headers it emits.
- **Out of scope:** any infrastructure you do not own; the upstream
  `Kyvera-Labs/verixa` repository settings; third-party verification providers;
  denial-of-service testing beyond single-request parser and size limits;
  anything that would require social engineering a maintainer.
- **Never against a shared or production database.** Use a throwaway one, or
  none, as this exercise did.
- **Findings get recorded, not fixed inline.** A pen-test PR that also changes
  authorization logic is two PRs, and the second one needs its own review.

## Environment

The exercise runs against the compiled server with no Postgres, no Redis and no
Docker. That is a _feature_: Prisma connects lazily, so `buildContainer()`
succeeds, every route is registered, and the guard logic — which is what this
checklist is about — is fully reachable.

```bash
pnpm --filter "@verixa/api^..." run build
pnpm --filter @verixa/api run build

NODE_ENV=production \
HOST=127.0.0.1 PORT=3123 \
DATABASE_URL="postgres://verixa:verixa@127.0.0.1:5499/verixa_pentest" \
SESSION_ACCESS_TOKEN_SECRET="pentest-secret-value-not-used-anywhere-else-0123456789" \
ENFORCE_HTTPS=false TRUST_PROXY=false \
  node apps/api/dist/server.js
```

`SESSION_ACCESS_TOKEN_SECRET` is the only variable with no default
(`packages/config/index.ts`), and the `DATABASE_URL` above points at a port
nothing listens on deliberately: storage-touching paths must fail the same way
every time, and no test may write to a real database.

A second instance with transport enforcement on, for the `4.02` and `4.09`
rows:

```bash
ENFORCE_HTTPS=true TRUST_PROXY=true PORT=3124 node apps/api/dist/server.js
```

What each condition costs you, and what it does not:

| Condition                | Consequence for the exercise                                  |
| ------------------------ | ------------------------------------------------------------- |
| No Postgres              | Anything reaching a repository returns 500, not real data     |
| No Redis                 | Session deny-list behaviour is untestable                     |
| No Docker                | Image and container rows (`4.02.18`, `4.02.19`) deferred      |
| Stub verification routes | Guards and status codes are real; persistence effects are not |

## Severity

Verixa is a bearer-credential platform: an access token _is_ the identity, and
a verification record is a person's government document. Severity is therefore
graded by what an attacker gains, not by how hard the test was to write.

| Level             | Meaning for Verixa                                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Critical**      | Authentication or tenant isolation defeated with real data: an attacker reads or mints another tenant's sessions, credentials, or verification documents; or gets code execution.                                   |
| **High**          | An authorization control can be bypassed by an unprivileged client, or a secret/credential material reaches an unauthorized reader. Impact is currently limited by a stub or missing persistence, not by a control. |
| **Medium**        | Real damage with effort or preconditions: information disclosure that aids an attack, transport or session weakness, missing brute-force control, cross-origin exposure.                                            |
| **Low**           | Hardening gap with no direct compromise: missing header, inconsistent error envelope, disclosure of non-sensitive internals.                                                                                        |
| **Informational** | Correct behaviour worth recording, or a design tradeoff that is deliberate and documented.                                                                                                                          |

Every finding in the report carries: severity, the WSTG ID, `file:line`,
**observed** output (not a prediction), why it matters here, the fix, and the
follow-up it belongs to.

## Status legend

- **PASS** — tested, behaves as it should. Recorded anyway; a checklist with
  only failures teaches nothing about what the control was.
- **FINDING** — tested, defective, see the finding ID in the report.
- **N/A** — not reachable in this build yet, with the reason and the trigger
  that makes it testable.
- **DEFERRED** — needs an environment this exercise did not have (database,
  Redis, Docker, a real browser).

## 4.01 Information gathering

| ID           | Test                                             | How to run it                                                                                                 | Status            |
| ------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ----------------- |
| WSTG-INFO-01 | Fingerprint the web server                       | `curl -i` on any route; look for `Server`, `X-Powered-By`                                                     | PASS (neither)    |
| WSTG-INFO-02 | Discover endpoints via the route table           | `GET /` → 404 body names method and path only                                                                 | PASS              |
| WSTG-INFO-04 | Map the attack surface from client-visible data  | No HTML, no sourcemaps served; API is JSON-only                                                               | N/A (no UI)       |
| WSTG-INFO-05 | Enumerate via error behaviour                    | Validation errors quote the JSON Schema path (`body/email must be string`) — the schema shape is discoverable | FINDING F-13, Low |
| WSTG-INFO-06 | Look for public data stores / registry artifacts | `pnpm-lock.yaml` ships in the image by design (SBOM value); `.env` is not in the build context                | PASS              |
| WSTG-INFO-08 | Fetch `robots.txt`, `security.txt`, metadata     | No `/.well-known/security.txt`, no `SECURITY.md` in the repository                                            | FINDING F-14, Low |

## 4.02 Configuration and deployment management

| ID           | Test                                                               | How to run it                                                                      | Status                                |
| ------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------- |
| WSTG-CONF-01 | TLS/SSL certificate                                                | Terminated at the proxy; see `tls-enforcement.md`                                  | N/A (no TLS here)                     |
| WSTG-CONF-02 | Mandatory and optional transport security                          | `GET /health` with `ENFORCE_HTTPS=true` → 308 + `cache-control: no-store`          | PASS                                  |
| WSTG-CONF-03 | Disable unused HTTP methods                                        | `PUT`/`GET` on a `POST`-only route → 404, not 405, no `Allow`                      | FINDING F-15, Informational           |
| WSTG-CONF-04 | Searchable directory indexing                                      | No static handler is registered; `GET /../../etc/passwd` → 404                     | PASS                                  |
| WSTG-CONF-05 | File extension / asset handling                                    | API serves JSON for every route                                                    | N/A                                   |
| WSTG-CONF-08 | Referrer-path information leakage                                  | Redirect `Location` carries only the request path                                  | PASS                                  |
| WSTG-CONF-09 | Unencrypted channels                                               | HSTS is emitted over cleartext too (inert per RFC 6797 §7.2)                       | FINDING F-16, Informational           |
| WSTG-CONF-10 | Admin interface exposure                                           | `/admin/*` is reachable unauthenticated and identifies the caller from `x-user-id` | **FINDING F-02, High**                |
| WSTG-CONF-11 | Network/infrastructure access controls                             | `127.0.0.1` bind; no management route exposed                                      | PASS                                  |
| WSTG-CONF-12 | Vulnerable and outdated components                                 | `container-scan.yml` (OS, blocking) + dependency artifact scan                     | DEFERRED (CI)                         |
| WSTG-CONF-13 | Intended application security controls                             | Rate limiting is wired to `NoopRateLimiter`                                        | **FINDING F-08, Medium**              |
| WSTG-CONF-18 | Provisioning of authentication credentials                         | No admin bootstrap; roles are assigned through `/admin/roles`                      | N/A (no real auth yet)                |
| WSTG-CONF-19 | Test the host's configuration against the platform hardening guide | Non-root UID 10001, no package manager, pruned bundle                              | DEFERRED (no Docker on the test host) |

## 4.03 Identity management

| ID            | Test                                          | How to run it                                                                               | Status   |
| ------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------- | -------- |
| WSTG-IDENT-01 | User enumeration                              | `POST /auth/login` with a well-formed bad address and a real one both → 401, identical body | PASS     |
| WSTG-IDENT-02 | Weak registration / password reset            | `POST /auth/register` needs a live database                                                 | DEFERRED |
| WSTG-IDENT-03 | Insecure workflow for password reset          | Reset flow exists in the domain, not yet routed                                             | N/A      |
| WSTG-IDENT-04 | Old session invalidation on credential change | Requires Postgres + Redis                                                                   | DEFERRED |

## 4.04 Authentication

| ID           | Test                                      | How to run it                                                                                                   | Status                                                             |
| ------------ | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| WSTG-ATHN-01 | Default / weak credentials                | None exist; no seeded user in the compose init                                                                  | PASS                                                               |
| WSTG-ATHN-02 | Password policy enforcement               | Schema accepts any string; the domain enforces the policy, and a policy failure is a 400 that names the rule    | FINDING F-11, Low (needs a live DB to confirm which layer answers) |
| WSTG-ATHN-03 | Lockout / anti-automation                 | 20 rapid `POST /auth/login` — no 429, no delay                                                                  | **FINDING F-08, Medium**                                           |
| WSTG-ATHN-04 | Credentials over an encrypted channel     | No cookie is set anywhere on the surface (verified across `/health`, `/auth/*`, `/admin/*`, `/verification/*`)  | PASS (and N/A until Issue 214's cookies are wired to a route)      |
| WSTG-ATHN-07 | Insufficient authentication in a workflow | `POST /verification` creates a request with no authentication at all                                            | **FINDING F-03, High**                                             |
| WSTG-ATHN-08 | Bypassing authentication results          | `authorization: Bearer anyone-can-type-this-reviewer-token` → 200 on reviewer routes                            | **FINDING F-01, High**                                             |
| WSTG-ATHN-12 | Testing for other authentication issues   | `x-forwarded-proto: HTTPS` is compared case-sensitively → 308 loop risk behind a terminator that capitalizes it | FINDING F-12, Low                                                  |

## 4.05 Authorization

The most productive chapter of this exercise, and the reason the checklist is
worth running at all: every defect found here is invisible to a scanner.

| ID           | Test                                      | How to run it                                                                                                                | Status                   |
| ------------ | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| WSTG-ATHZ-01 | Path traversal / resource access controls | `GET /verification/%2e%2e%2f%2e%2e%2fadmin%2froles` → 200, and the decoded `../../admin/roles` is echoed back as `requestId` | **FINDING F-05, Medium** |
| WSTG-ATHZ-02 | Direct use of an object or function       | `POST /verification/review-queue/:id/decision` with a forged reviewer header → `{"status":"approved"}`                       | **FINDING F-01, High**   |
| WSTG-ATHZ-03 | BOLA — object-level read                  | `GET /verification/11111111-…` with no auth → 200                                                                            | **FINDING F-05, Medium** |
| WSTG-ATHZ-04 | BOLA — object-level write                 | Body carries `subjectUserId` and `orgId`; the caller supplies both                                                           | **FINDING F-03, High**   |
| WSTG-ATHZ-05 | Privilege escalation                      | `x-user-id: attacker` passes the admin guard into the permission check                                                       | **FINDING F-02, High**   |
| WSTG-ATHZ-06 | Insecure direct object reference          | Reviewer queue claim/decision routes keyed only on a substring check                                                         | **FINDING F-01, High**   |
| WSTG-ATHZ-07 | Injected payload into a parameter         | `?limit=-1`, oversized, and non-numeric query values are ignored rather than honoured — no unbounded fetch is reachable      | PASS                     |
| WSTG-ATHZ-08 | Weaknesses in multi-tenant isolation      | Requires a populated database; the identifier handling above is the reachable half                                           | FINDING F-03 + DEFERRED  |

## 4.06 Session management

| ID           | Test                                 | How to run it                                                                                        | Status                                                                   |
| ------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| WSTG-SESS-01 | Session structure prediction         | No session issued over HTTP yet                                                                      | N/A (Issue 214's policy is unit- and wire-tested in `packages/sessions`) |
| WSTG-SESS-02 | Session binding to the user / logout | Needs Postgres + Redis                                                                               | DEFERRED                                                                 |
| WSTG-SESS-03 | Cookie attributes                    | `sessionCookies()` emits `HttpOnly`-less CSRF cookie by documented exception, everything else scoped | PASS (at the policy layer; no route uses it yet)                         |
| WSTG-SESS-04 | Session timeout                      | `SessionExpiryPolicy` defaults, no server-side idle timer exercised                                  | DEFERRED                                                                 |
| WSTG-SESS-05 | Insufficient session expiration      | Revocation deny-list tested in `packages/sessions` against real Redis in CI                          | DEFERRED (local Redis absent)                                            |
| WSTG-SESS-08 | Session fixation                     | No session cookie is set on login at all today                                                       | N/A until the cookie wiring lands                                        |

## 4.07 Input validation

| ID                 | Test                                         | How to run it                                                                                                                     | Status                                                                                     |
| ------------------ | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| WSTG-INPV-01       | Reflected XSS                                | JSON responses; the unvalidated `requestId` echo is the one reflection vector, served with `application/json`                     | FINDING F-05, Medium                                                                       |
| WSTG-INPV-03       | SQLi                                         | `POST /auth/login` with `x@y.co' OR '1'='1` → 401, identical to a wrong password; all reads are Prisma-parameterized              | PASS                                                                                       |
| WSTG-INPV-04       | ORM injection / operator objects             | `{"email":{"$ne":null}}` → 400 `body/email must be string`                                                                        | PASS                                                                                       |
| WSTG-INPV-05       | XML / XXE                                    | No XML parser on any route; `text/plain` → 400 `body must be object`                                                              | N/A                                                                                        |
| WSTG-INPV-06       | AMF / binary deserialization                 | None                                                                                                                              | N/A                                                                                        |
| WSTG-INPV-08,09,10 | Command and code injection                   | No `exec`, no template rendering from request data                                                                                | PASS (source review)                                                                       |
| WSTG-INPV-10       | Remote file inclusion                        | No static handler                                                                                                                 | N/A                                                                                        |
| WSTG-INPV-12       | HTTP request fragmentation / CRLF            | `GET /%0aLocation:%20evil` → 308 whose `Location` keeps `%0A` encoded; no header injection                                        | PASS                                                                                       |
| WSTG-INPV-13       | Web caches                                   | Only the redirect carries `no-store`; JSON responses set no `Cache-Control` at all                                                | FINDING F-07, Low                                                                          |
| WSTG-INPV-14       | Blind attacks / SSRF                         | The verification provider is a stub and never fetches a caller-supplied URL                                                       | N/A until a real provider adapter lands (then re-test: this becomes a live SSRF candidate) |
| WSTG-INPV-15       | SMTP / LDAP / LDAP injection                 | No LDAP; mail sender is `NullCredentialNotifier`                                                                                  | N/A                                                                                        |
| WSTG-INPV-16       | Unicode / encoding                           | 120 KB of UTF-8 in a body → 413; no parser crash                                                                                  | PASS                                                                                       |
| WSTG-INPV-17,18    | Mass assignment / parameter pollution        | `role` and `organizationId` in the register body → 400 `body must NOT have additional properties` (`additionalProperties: false`) | PASS                                                                                       |
| WSTG-INPV-19       | Prototype pollution                          | `{"__proto__":{"isAdmin":true}}` → 400 `FST_ERR_CTP_INVALID_JSON_BODY` (Fastify's JSON parser refuses the key)                    | PASS                                                                                       |
| WSTG-INPV-20,21    | HTTP header / verb tampering                 | `OPTIONS /auth/login` → 404 (no CORS preflight handler); no wildcard `Access-Control-Allow-Origin` on any response                | FINDING F-09, Low                                                                          |
| WSTG-INPV-22,23    | Testing for Referrer / HTTP header responses | `Host: evil.example` → 308 with `location: https://evil.example/health`                                                           | **FINDING F-06, Medium**                                                                   |
| WSTG-INPV-24       | Response code splitting                      | Single JSON content type, no sniffable markup                                                                                     | PASS                                                                                       |

## 4.08 Error handling

| ID           | Test                                         | How to run it                                                                                                                                                                     | Status                   |
| ------------ | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| WSTG-ERRH-01 | Stack traces and internal paths in responses | `POST /auth/login` with a dead database → `{"error":{"code":"INTERNAL_ERROR","message":"An unexpected error occurred."}}`                                                         | PASS (auth routes catch) |
| WSTG-ERRH-02 | Application availability / DoS               | 4 MB body → 413; 6,000-deep nested array → 400, process still healthy; 4 KB path → 414                                                                                            | PASS                     |
| WSTG-ERRH-03 | Misuse of an unhandled error path            | `GET /admin/roles` with `x-user-id` → 500 whose `message` is Prisma's own text, naming `prisma.userRoleAssignment.findMany()` and `Can't reach database server at 127.0.0.1:5499` | **FINDING F-04, Medium** |
| WSTG-ERRH-04 | Error type / information leakage             | Validation messages quote schema paths; default Fastify envelope differs from the domain envelope                                                                                 | FINDING F-04, F-13, Low  |

## 4.09 Cryptography

| ID           | Test                             | How to run it                                                                                   | Status                         |
| ------------ | -------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------ |
| WSTG-CRYP-01 | Transport-wide protection        | `ENFORCE_HTTPS` + HSTS; `preload` rejected with reasons in `tls-enforcement.md`                 | PASS                           |
| WSTG-CRYP-02 | Weak algorithms / random numbers | Argon2id for credentials, no `Math.random()` in token paths (`JwtTokenSigner`, `generateToken`) | PASS (source review)           |
| WSTG-CRYP-03 | Padding oracles                  | No CBC; HMAC/AES-GCM only                                                                       | N/A                            |
| WSTG-CRYP-04 | Sensitive data in transit        | Access tokens never logged in plaintext by the app; no secret in any 4xx/5xx body observed      | PASS                           |
| —            | Secrets in the image             | No `.env` in the build context; `.env.example` only                                             | PASS (contents asserted in CI) |

## 4.10 Business logic

| ID              | Test                                                | Observed                                                           | Status                 |
| --------------- | --------------------------------------------------- | ------------------------------------------------------------------ | ---------------------- |
| WSTG-BUSL-02    | Data validation from the client                     | Tenancy identifiers (`orgId`, `subjectUserId`) are client-supplied | **FINDING F-03, High** |
| WSTG-BUSL-03    | Bypassing work / workflow steps                     | `…/decision` reachable without ever claiming the case              | **FINDING F-01, High** |
| WSTG-BUSL-04    | Manipulating price / quantities                     | No commerce surface                                                | N/A                    |
| WSTG-BUSL-05,06 | Forced browsing / insecure direct object references | Covered under 4.05                                                 | FINDING F-05           |
| WSTG-BUSL-08    | Integrity checks on transport                       | Nothing signed client-side; tokens are bearer                      | N/A                    |
| WSTG-BUSL-13    | Reuse of negative values / counters                 | `?limit=-1` ignored rather than honoured                           | PASS                   |
| WSTG-BUSL-14    | Unintended business logic outcomes                  | Anyone can move a verification request to `approved`               | **FINDING F-01, High** |

## 4.11 Client-side

`apps/api` serves no HTML, so the browser-execution chapter is out of scope
for the API. Two rows transfer to whoever builds the admin surface, and they
are listed here so they do not get lost:

| ID                 | Test                              | Status                                                                                        |
| ------------------ | --------------------------------- | --------------------------------------------------------------------------------------------- |
| WSTG-CLNT-01,04,07 | DOM-based XSS, JS, client storage | N/A — no served documentation or admin UI today                                               |
| WSTG-CLNT-09       | Content Security Policy           | **No CSP on any response.** Issue 212 owns the policy; recorded in the report as FINDING F-07 |

## 4.12 API-specific

The chapter that matters most for a headless JSON service.

| ID           | Test                                               | How to run it                                                                                                  | Status                   |
| ------------ | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------ |
| WSTG-APIT-01 | Data from arbitrary sources                        | Body, path and headers all validated by AJV before the handler; header-borne identity is the exception         | **FINDING F-02**         |
| WSTG-APIT-02 | Not authenticated / not authorized calls           | `/verification*` and `/admin*` reachable with no credential                                                    | **FINDING F-01, F-03**   |
| WSTG-APIT-03 | Mutating verbs on read endpoints                   | 404 rather than 405; no state change on `GET` observed                                                         | PASS / F-15              |
| WSTG-APIT-04 | Mass assignment through the schema                 | `additionalProperties: false` on every auth and verification body; `/admin/*` bodies have **no schema at all** | FINDING F-10, Low        |
| WSTG-APIT-05 | Broken object property level authorization (BOPLA) | `orgId` accepted from the request body without a server-side tenant binding                                    | **FINDING F-03, High**   |
| WSTG-APIT-06 | Rate limiting and quotas                           | `NoopRateLimiter` at `apps/api/src/composition-root.ts:324`                                                    | **FINDING F-08, Medium** |
| WSTG-APIT-07 | Injection through a parameterized payload          | Covered under 4.07; ORM layer parameterizes                                                                    | PASS                     |
| WSTG-APIT-08 | Improper asset management                          | No upload handler is registered — `POST /verification/:id/evidence` answers 415 on `multipart/form-data`       | FINDING F-17, Low        |
| WSTG-APIT-09 | Inventory and documentation exposure               | No `/docs`, no `/openapi.json` served; the schemas are compiled from the code and stay in the repo             | PASS                     |

## Reading the checklist before you file something

Three questions keep a pen-test report honest, and each has bitten this
exercise:

1. **Is the defect the control, or the absence of a dependency?** A route that
   returns canned data is a stub, not a bypass. Where persistence is missing,
   the report says so and grades what the _code in front of you_ permits.
2. **Would this finding survive being put next to the roadmap?** Several rows
   land on Issues 203, 204, 205, 209, 211 and 212 — already open, already
   owned. Those get cross-referenced rather than re-invented.
3. **What is the smallest honest severity?** Over-grading is how reports get
   ignored. The reviewer-header bypass is High, not Critical, because the queue
   is stub data today — and the report states exactly what makes it Critical.

## After every exercise

- File every finding, including the PASSes, in the dated report.
- For each finding, name the follow-up: an existing roadmap issue or a new
  one described well enough to be filed by someone with write access.
- Re-run the exercise against a build with Postgres and Redis present, and
  mark the DEFERRED rows as they get covered.
- Add a row whenever new surface appears — a route, a content type, a new
  trust boundary. A checklist that stops growing starts lying.

## Related

- [pen-test-findings-2026.md](./pen-test-findings-2026.md) — this exercise's results.
- [docs/security/tls-enforcement.md](./tls-enforcement.md), [secure-cookies.md](./secure-cookies.md), [container-hardening.md](./container-hardening.md) — the three issues whose controls were exercised here.
- [docs/security/threat-register.md](./threat-register.md) — where a finding that turns out to be an accepted threat belongs.
- [docs/guides/error-handling.md](../guides/error-handling.md) — the envelope FINDING F-04 deviates from.
- [Roadmap Phase 11](../../planning/issues/phase-11-security-hardening.md) — Issues 201–220.
