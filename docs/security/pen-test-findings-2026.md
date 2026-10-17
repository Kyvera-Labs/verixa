# Penetration-Test Findings — 2026-10-17

First internal exercise against [pen-test-checklist.md](./pen-test-checklist.md)
(roadmap Issue 217). Manual, adversarial, one day, one tester, the HTTP surface
of `apps/api`.

**Every finding is filed, including the ones that held up.** The PASS rows are
in §5 because a report of only failures cannot be re-run or compared.

## Summary

| ID   | Finding                                                                  | Severity      | Follow-up             |
| ---- | ------------------------------------------------------------------------ | ------------- | --------------------- |
| F-01 | Reviewer role is a substring match on `Authorization`                    | **High**      | new issue             |
| F-02 | `/admin/*` takes the caller's identity from `x-user-id`                  | **High**      | new issue + Issue 219 |
| F-03 | `POST /verification` is unauthenticated and takes tenancy from the body  | **High**      | new issue + Issue 202 |
| F-04 | Unhandled storage errors reach the client as Prisma's own text           | **Medium**    | new issue             |
| F-05 | `requestId` is not validated; object reads are unguarded and echoed back | **Medium**    | Issue 210             |
| F-06 | The HTTPS redirect target is built from an unvalidated `Host`            | **Medium**    | Issue 213 follow-up   |
| F-07 | No CSP, no `X-Content-Type-Options`, no `Cache-Control` on responses     | **Low**       | Issues 203, 212       |
| F-08 | No rate limiting or lockout in effect (`NoopRateLimiter`)                | **Medium**    | Issue 209             |
| F-09 | No CORS policy: preflight answers 404                                    | **Low**       | Issue 204             |
| F-10 | `/admin/*` request bodies have no schema                                 | **Low**       | Issue 210             |
| F-11 | Password policy failures are reported by the schema, not the domain      | **Low**       | Issue 219             |
| F-12 | `X-Forwarded-Proto` matched case-sensitively; `Forwarded:` ignored       | **Low**       | Issue 213 follow-up   |
| F-13 | Validation errors disclose the JSON Schema shape                         | **Low**       | accept or tighten     |
| F-14 | No `security.txt`, no `SECURITY.md`                                      | **Low**       | Issue 211             |
| F-15 | Unsupported methods answer 404, never 405, with no `Allow`               | Informational | accept                |
| F-16 | HSTS is emitted over cleartext HTTP                                      | Informational | accept                |
| F-17 | The evidence-upload route cannot accept the media type it describes      | **Low**       | Phase 9               |
| —    | Container/image rows (`4.02.19`, WSTG-CONF-12)                           | **Deferred**  | CI                    |

17 findings, 3 High, 5 Medium, 7 Low, 2 Informational, plus the deferrals. No
Critical: nothing in this build let an unauthorized caller read another
tenant's persisted data, because no persisted data was reachable at all — see
§6 for what changes that.

## 1. Environment and how to reproduce

```bash
pnpm --filter "@verixa/api^..." run build && pnpm --filter @verixa/api run build

NODE_ENV=production HOST=127.0.0.1 PORT=3123 \
DATABASE_URL="postgres://verixa:verixa@127.0.0.1:5499/verixa_pentest" \
SESSION_ACCESS_TOKEN_SECRET="pentest-secret-value-not-used-anywhere-else-0123456789" \
ENFORCE_HTTPS=false TRUST_PROXY=false node apps/api/dist/server.js

NODE_ENV=production HOST=127.0.0.1 PORT=3124 \
DATABASE_URL="postgres://verixa:verixa@127.0.0.1:5499/verixa_pentest" \
SESSION_ACCESS_TOKEN_SECRET="pentest-secret-value-not-used-anywhere-else-0123456789" \
ENFORCE_HTTPS=true TRUST_PROXY=true node apps/api/dist/server.js
```

`NODE_ENV=production` because an error path behaves differently in development
and the deployment is what is being judged. Nothing else in the environment
existed: **no Postgres, no Redis, no Docker**. Port `5499` is closed on
purpose, so every storage-touching request fails identically and nothing this
exercise did could write to a real database.

All outputs below are copied from the responses, not reconstructed.

## 2. High findings

### F-01 — the reviewer role is a substring match on `Authorization`

`apps/api/src/routes/verification.ts:150`

```ts
function checkReviewer(req: FastifyRequest, reply: FastifyReply): boolean {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.includes("reviewer")) {
```

Three reviewer routes use it (`:194` claim, `:230` queue, `:244` decision).
`includes()` is a case-sensitive substring test on a header the client types.

Observed, against `:3123`:

```http
POST /verification/review-queue/11111111-1111-1111-1111-111111111111/decision
authorization: Bearer anyone-can-type-this-reviewer-token
content-type: application/json
{"decision":"approve"}

HTTP/1.1 200 OK
{"requestId":"11111111-1111-1111-1111-111111111111","status":"approved"}
```

And the same request without the word:

```http
authorization: Bearer abc        → 403 {"error":{"code":"FORBIDDEN","message":"Reviewer role required"}}
```

Also accepted: `authorization: not-a-reviewer-at-all` (200), `authorization: I
am a reviewer today` (200). Rejected: `REVIEWER` (403) — the check is
case-sensitive, so it is not even a reliable gate for its own intended value.

**Why it is High and not Critical:** the queue and the decision handler are
Phase 9 stubs that return canned objects; the approval is not persisted, so no
real subject was verified by this request. **Why it is not lower:** the control
that is supposed to stand between the public internet and "approve this
person's identity document" is a word match on an attacker-chosen string, and
it is reachable from a buildable production image today. The moment the route
meets the repository, the same one-line request approves a KYC subject. That is
the definition of a control that fails open.

**Remediation:** delete `checkReviewer`. The routes should consume the same
session/principal the rest of the platform uses — `SessionAccessGuard` with an
explicit `reviewer` permission check from `@verixa/authorization`, denying when
the principal is absent. A guard that _defaults to deny_ is the point: the fix
is not a better string match, it is the absence of a fallback.

**Follow-up:** new issue, "replace the substring reviewer check with the
session guard and a reviewer permission", linked from Issue 219 (ASVS V3/V4)
and blocking any persistence work on the review queue.

### F-02 — `/admin/*` takes the caller's identity from a request header

`packages/authorization/interface/admin-roles.routes.ts:88`

```ts
const userId = header(request, "x-user-id");
// … and at :93 / :172 / :188
header(request, "x-organization-id") ?? null;
```

The file's own comment at `:73` is candid about it — "by the session layer
through `x-user-id` until the principal plugin lands" — so this is a known
stopgap. What the exercise adds is that the stopgap is **reachable and does not
deny**: a header any client can set is the whole of the caller's identity, and
its format is not even checked.

Observed:

```http
GET /admin/roles                      → 403 {"error":"Forbidden"}
GET /admin/roles
x-user-id: attacker
x-organization-id: attacker-org       → 500 (below — and note what it says)

POST /admin/roles  x-user-id: attacker …  → 500
DELETE /admin/user-role-assignments/1  x-user-id: attacker … → 500
```

The `403 → 500` transition is the finding: with no header the guard short-circuits;
with _any_ value the request proceeds into `hasPermission`, which is where the
storage layer stopped it. `attacker` is not a UUID. Nothing in the interface
layer requires it to be one.

Behind a proxy that strips nothing, or on any path where a client can set
`x-user-id` (which is every path, since nothing verifies it), this is privilege
escalation to any role in any organization — and the response body confirms
which internal check ran.

**Remediation:** the principal comes from the session token, not a header, and
an inbound `x-user-id` is rejected outright rather than ignored. If a trusted
internal proxy must assert identity, that belongs behind a shared-secret header
the edge removes from external traffic, with `TRUST_PROXY` as the gate — and
that gate has to be tested, not assumed.

**Follow-up:** new issue, "admin routes must derive the principal from the
session, not `x-user-id`", with a blocker label for anything that ships
`/admin/*` publicly.

### F-03 — `POST /verification` is unauthenticated and takes tenancy from the body

`apps/api/src/routes/verification.ts:178`, schema at `:12`

```json
{ "subjectUserId": "victim-user", "orgId": "victim-org", "verificationType": "passport" }
```

```http
POST /verification                    (no authorization header of any kind)
→ HTTP/1.1 201 Created
  {"requestId":"req_mo…","status":"pending_evidence"}
```

`orgId` and `subjectUserId` are both supplied by the caller and both are
identity-bearing: who is being verified, and which organization owns the
request. There is no session, no tenant binding, no check that the caller may
act for `victim-user`. Today it creates a stub record; with persistence it
creates a verification request against a real subject in a real organization —
which is the multi-tenancy threat Issue 202's model already lists (a forged
verification record is how an attacker passes as someone else), and it is the
BOPLA pattern WSTG-APIT-05.

**Remediation:** derive `orgId` from the authenticated session, never from the
body; require `subjectUserId` to equal the session subject unless the caller
holds a permission to submit on another's behalf; add the request to the audit
log like every other state change.

**Follow-up:** new issue for the body-supplied tenancy, cross-referenced to
Issue 202 (transport/infra threat model) and Phase 9's verification persistence.

## 3. Medium findings

### F-04 — unhandled storage errors reach the client as Prisma's own text

Observed, `GET /admin/roles` with the spoofed headers from F-02:

```json
{
  "statusCode": 500,
  "error": "Internal Server Error",
  "message": "\nInvalid `prisma.userRoleAssignment.findMany()` invocation:\n\n\nCan't reach database server at `127.0.0.1:5499`\n\nPlease make sure your database server is running at `127.0.0.1:5499`."
}
```

Three things leak: the internal database host and port, the Prisma model and
method that the authorization check uses, and the fact that this code path
reaches `userRoleAssignment` before rejecting the caller — all of which
materially helps someone who is probing for a way in.

Two causes, both structural:

1. **No global error handler.** `setErrorHandler` and `setNotFoundHandler`
   appear nowhere in `apps/api/src` (grep: no matches). The `/auth/*` routes
   catch their own unexpected throws and answer the platform envelope
   (`{"error":{"code":"INTERNAL_ERROR","message":"An unexpected error
occurred."}}`), which is why `POST /auth/login` against the same dead
   database leaked nothing. Everything else falls through to Fastify's default
   handler, which serializes `err.message` verbatim.
2. `packages/authorization/interface/admin-roles.routes.ts:57` `replyError`
   does the same deliberately at `:67` for non-`AuthorizationError` cases.

**Remediation:** one `setErrorHandler` at the composition root that logs the
error object and sends the platform envelope, plus `replyError` restricted to
known domain errors with the rest routed through the same handler. The generic
message is not a loss: F-04's own evidence shows what the useful text costs.

**Follow-up:** new issue, "global error handler: one envelope, no internals".
This is also the kind of thing Issue 219 (ASVS) scores under V3/V7.

### F-05 — `requestId` is unvalidated, unguarded, and echoed back

Observed:

```http
GET /verification/11111111-1111-1111-1111-111111111111   (no auth) → 200
GET /verification/%2e%2e%2f%2e%2e%2fadmin%2froles         (no auth) → 200
  {"requestId":"../../admin/roles","status":"pending_evidence"}
```

Two separate problems in one line of code (`:222`, and `z.string()` at `:195`,
`:223`, `:248` — a `z.string()` that accepts anything).

- **No guard at all** on a read of someone's verification status: no
  `authorization` header, no session, no tenant check. It answers 200 for any
  identifier. Today the answer is a constant, so nothing is disclosed; with the
  real repository this is exactly the object-level read WSTG-ATHZ-03 names.
- **Arbitrary input is reflected** into the response body, including
  traversal-shaped strings that were decoded on the way in. The content type is
  `application/json`, so the browser does not render it — this is not XSS today.
  It _is_ an unvalidated identifier arriving at a data layer, which is where
  Issue 210's injection review is supposed to look.

**Remediation:** validate the parameter as a UUID at the schema; put the read
behind the session guard with an organization check; do not echo the parameter —
answer with the record's own identifier or nothing.

**Follow-up:** Issue 210 (injection hardening), plus F-03's guard work.

### F-06 — the HTTPS redirect is built from an unvalidated `Host`

Against `:3124` (`ENFORCE_HTTPS=true`):

```http
GET /health
host: evil.example

HTTP/1.1 308 Permanent Redirect
location: https://evil.example/health
cache-control: no-store
```

`httpsRedirectTarget` (`apps/api/src/plugins/security-headers.ts:171`, used at
`:340`) validates the Host's _syntax_ — `creds@evil.example`,
`evil.example/`, `[::1` are all refused with 400 "Request Host is not usable to
build an HTTPS redirect target." It does not validate the Host's _identity_, so
whatever well-formed authority a client presents becomes the redirect target.

Realistic reach: an attacker who controls the Host a victim's request carries —
a link in an `<a ping>`, an SSRF pivot, a proxy that forwards `Host` from an
absolute-form request line — gets a permanent redirect to their own TLS
endpoint, where the victim's cookies and Basic-auth headers arrive.
`cache-control: no-store` on the 308 removes the shared-cache poisoning variant,
which is why this is Medium rather than High.

**Remediation:** a canonical host at the edge. Either a config allow-list
(`PUBLIC_HOSTS` / `ALLOWED_HOSTS`, validated at startup the way `ENFORCE_HTTPS`

- `TRUST_PROXY` already are) or build the redirect from the proxy's
  `X-Forwarded-Host` _only_ when `TRUST_PROXY` is set, and refuse the request
  otherwise. Refusing is fine: a deployment that reaches this path has already
  misconfigured its edge, and a 400 tells them so.

**Follow-up:** Issue 213 follow-up on the same code path this PR touched. Filed
rather than silently fixed here because it is a deployment-level decision —
which authority is canonical is the operator's to state, not a reviewer's to
guess at in a hardening PR.

### F-07 — no CSP, no `X-Content-Type-Options`, no `Cache-Control` on responses

Full header set on a JSON 200 from `:3124`:

```http
HTTP/1.1 200 OK
strict-transport-security: max-age=31536000; includeSubDomains
content-type: application/json; charset=utf-8
content-length: 15
Date: …
Connection: keep-alive
Keep-Alive: timeout=72
```

`security-headers.ts` currently emits HSTS and the redirect's `no-store` and
nothing else — `x-content-type-options`, `x-frame-options`, `referrer-policy`
and CSP are absent from 200, 404 and 500 alike. For a pure JSON API the
practical exposure is modest (`nosniff` is about legacy content sniffing;
`X-Frame-Options` about a UI that does not exist yet), but F-05's reflected
input and Issue 212's future admin surface both make the missing CSP live, and
a bearer-token API with no `Cache-Control` is relying on the default behaviour
of every cache between it and a user.

**Follow-up:** Issue 203 (the header set this plugin was meant to own) and Issue
212 (CSP for served surfaces). Cross-referenced, not re-invented.

### F-08 — no rate limiting or lockout is in effect

`apps/api/src/composition-root.ts:324`:

```ts
const rateLimiter = new NoopRateLimiter();
```

`AuthenticateWithPassword` does the work correctly
(`packages/credentials/application/use-cases/authenticate-with-password.ts:175`
`check`, `:247` `recordFailure`, `:301` `reset`) against a `RateLimiter` port.
The production adapter is the one whose comment at `composition-root.ts:318`
says it plainly: _"`NoopRateLimiter` always allows requests — rate limiting is
Phase 15."_

Twenty consecutive `POST /auth/login` with different passwords all reached the
handler; none returned 429 and none was delayed. **Honest limitation:** every
one of those answered 500 because the database was absent, so over HTTP the run
proves the _absence of a 429_, not the absence of a counter. The source proves
the rest, and the source is what a real instance will run.

**Follow-up:** Issue 209 (brute-force protection policy). Until it lands, a
credential-stuffing run against `/auth/login` is limited only by the attacker's
patience and the connection pool.

## 4. Low and informational

- **F-09 — no CORS policy.** `OPTIONS /auth/login` → 404
  `Route OPTIONS:/auth/login not found`; no `Access-Control-Allow-*` on any
  response, including requests carrying `origin: https://evil.example`. This
  **fails closed** for browser callers today, which is the safe direction, but
  it is fail-closed by omission rather than by a policy, so the first person
  who needs a browser client will improvise one. Issue 204.
- **F-10 — `/admin/*` bodies have no schema.** Every auth and verification
  route sets `additionalProperties: false`; the admin role and
  role-assignment bodies are read from `request.body` unvalidated. Not
  exploitable while F-02 blocks at the guard, but it is the same
  unvalidated-input-arriving-at-the-data-layer that F-05 records for
  `requestId`. Issue 210's review should include these.
- **F-11 — password policy reported by the schema, not the domain.** The
  register schema bounds `password` with `minLength`, while the domain enforces
  the real policy; the route comment says the split is deliberate. A 400 naming
  a length rule the domain also enforces is a small information gift and a
  maintenance trap. Re-test with a live database to see which layer answers
  first. Issue 219 (ASVS V2).
- **F-12 — `X-Forwarded-Proto` is matched case-sensitively, and `Forwarded:` is
  ignored.** On `:3124`: `x-forwarded-proto: http` → 308 ✓; `http, https` → 308 ✓
  (first value wins, which is the safe reading); **`HTTPS` → 308** ✗; `htt ps` →
  308 ✓; `forwarded: for=1.2.3.4;proto=https` → 308 (RFC 7239 is not consulted).
  A TLS terminator that capitalizes the scheme, or that emits only
  `Forwarded:`, sits in an infinite redirect loop with this app. RFC 9110 §4.1
  makes the scheme case-insensitive. Cheap fix, real outage prevention: compare
  lowercased, and read `Forwarded` when present.
- **F-13 — validation errors disclose the schema shape.** `body must have
required property 'displayName'`, `body/email must be string`. Ordinary for a
  JSON API and genuinely useful to legitimate integrators; recorded because
  Issue 219 may want it suppressed in production, not because it is a
  vulnerability.
- **F-14 — no disclosure channel.** No `SECURITY.md`, no
  `/.well-known/security.txt`, and the repository has no `issues: write` from a
  scanner (deliberately, see `container-scan.yml`). A finder currently has
  nowhere documented to send a report. Issue 211 owns this.
- **F-15 — 404 for unsupported methods.** `GET /auth/login` and `PUT
/auth/login` both answer 404 rather than 405, with no `Allow`. Harmless; it
  does mean method probing gives no signal, which is arguably the point.
- **F-16 — HSTS over cleartext.** `:3123` (`ENFORCE_HTTPS=false`) still sends
  `strict-transport-security` on `GET /health` over HTTP. RFC 6797 §7.2 makes a
  user agent ignore it there, so the header is inert rather than dangerous.
  Recorded so nobody later reads it as evidence that enforcement is on.
- **F-17 — the evidence upload route cannot receive evidence.**
  `POST /verification/11111111-…/evidence` with `multipart/form-data` → 415
  `Unsupported Media Type`: no multipart parser is registered, so the
  `req.file?.()` path at `verification.ts:200-205` is dead code. Not a
  vulnerability — but it means the _upload_ rows of §4.07 (filename handling,
  size limits on a real stream, content sniffing) were **not** exercised, and
  must be re-run the day `@fastify/multipart` lands. My first attempt at a
  traversal filename (`;filename=../../../../etc/passwd`) produced only the 415,
  so it tested nothing about path safety.

## 5. What held up

Controls that were attacked and did not move. Each of these is a regression
target: if one of these turns into a finding later, something else broke.

| Test                                                | Result                                                                                        |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `{"__proto__":{"isAdmin":true}}` in a JSON body     | 400 `FST_ERR_CTP_INVALID_JSON_BODY` — Fastify's parser refuses the key                        |
| `role`, `organizationId` added to the register body | 400 `body must NOT have additional properties`                                                |
| `{"email":{"$ne":null},"password":{"$ne":null}}`    | 400 `body must be object` / `body/email must be string`                                       |
| `x@y.co' OR '1'='1` in the login email              | 401, byte-identical to a wrong password; parameterized ORM reads                              |
| 4 MB JSON body                                      | 413 `FST_ERR_CTP_BODY_TOO_LARGE`                                                              |
| 6,000-deep nested array                             | 400, process still serving                                                                    |
| 4,096-character path segment                        | 414 `FST_ERR_MAX_PARAM_LENGTH`                                                                |
| `text/plain` and malformed JSON bodies              | 400, no parser crash                                                                          |
| `GET /%0aLocation:%20evil` (CRLF in the path)       | 308 whose `Location` keeps `%0A` encoded — no header injection                                |
| `Host: creds@evil.example`, `evil.example/`, `[::1` | 400, refused before a redirect is built                                                       |
| User enumeration via login                          | identical 401 body for unknown address, bad password, and an injection-shaped address         |
| Unexpected error on `/auth/*`                       | generic `INTERNAL_ERROR` envelope, nothing internal in the body                               |
| Server fingerprinting                               | no `Server`, no `X-Powered-By` header anywhere                                                |
| Cookies                                             | `Set-Cookie` on **zero** responses across `/health`, `/auth/*`, `/admin/*`, `/verification/*` |
| `/` and unknown routes                              | 404 naming only the method and path                                                           |
| No OpenAPI / `/docs` surface served                 | confirmed by direct request                                                                   |
| TLS enforcement + redirect hygiene                  | 308, `cache-control: no-store`, HSTS preserved on the redirect                                |

The cookie row deserves its note: Issue 214's policy
(`packages/sessions/infrastructure/http/cookie-config.ts`) is the
strongest-tested thing in this PR and the least
exercised by this exercise, because **no route sets a cookie yet**. The wire
tests in `cookie-config.spec.ts` (`describe("on the wire")`, over `node:http`)
are what stand in for a live check until the login route starts issuing
sessions. Do not let that row read as "cookies are secure in production" — they
are correct in a policy module that production has not called yet.

## 6. What this exercise could not reach

Stated so the next run is longer, not so this one looks complete.

- **Nothing that needed a database.** Registration, login success, rotation,
  reuse detection, revocation, session fixation (WSTG-SESS-02/04/05/08),
  password policy ordering (F-11). `docker compose up` and re-run; half of
  §4.04 and most of §4.06 are waiting on it.
- **Nothing that needed Redis.** The deny-list and its TTL behaviour.
- **Nothing that needed Docker.** The container rows (`4.02.19`, WSTG-CONF-12)
  are deferred: no Docker daemon on the test host. `container-scan.yml` and the
  `docker` job in `ci.yml` are the substitute, and the fact that they were
  _added_ by this PR means they have never run — see the disclosure in the PR
  description.
- **No browser, so no client-side chapter.** No HTML is served, so §4.11 is
  untestable until an admin surface exists (Issue 212).
- **Stubbed verification.** F-01 and F-03 are graded against the code that is
  in front of us, with the persistence effects they will have predicted
  explicitly rather than claimed as observed.
- **Single tester, single day, no tooling beyond `curl`.** No Burp/ZAP, no
  fuzzing corpus, no timing analysis. Session token entropy, Argon2 parameter
  adequacy and the audit hash chain were reviewed in source, not attacked.

## 7. Follow-ups to file

Not filed by this exercise: opening issues in `Kyvera-Labs/verixa` is a
shared-state action with no authorization behind it, and a bot-fetched account
deciding the maintainers' queue is not how this should work. These are
described well enough to paste.

| New issue title                                                                               | Priority | Blocks                                |
| --------------------------------------------------------------------------------------------- | -------- | ------------------------------------- |
| Replace the reviewer substring check with the session guard and a `reviewer` permission       | P0       | F-01; any review-queue persistence    |
| Admin routes must derive the principal from the session, not `x-user-id`                      | P0       | F-02; any public `/admin/*`           |
| `POST /verification` must take tenancy from the session, not the body                         | P0       | F-03, F-05                            |
| Global `setErrorHandler`: one platform envelope, no library text in responses                 | P1       | F-04                                  |
| Canonical-host allow-list for the HTTPS redirect (or `X-Forwarded-Host` behind `TRUST_PROXY`) | P1       | F-06                                  |
| Accept case-insensitive `X-Forwarded-Proto`, honour RFC 7239 `Forwarded`                      | P2       | F-12                                  |
| Schema-validate `/admin/*` request bodies (`additionalProperties: false`)                     | P2       | F-10                                  |
| Declare `files` in each workspace `package.json` so `pnpm deploy` stops copying source        | P2       | follow-up in `container-hardening.md` |

Existing roadmap issues this exercise touched and did not need to duplicate:
**203** (header set), **204** (CORS), **205** (CSRF — nothing to protect until
cookies are issued, which is exactly why the cookie row in §5 is written the
way it is), **209** (brute force), **210** (injection review — add the admin
bodies and the `requestId` parameter), **211** (`security.txt`), **212** (CSP),
**213** follow-up (canonical host), **219** (ASVS: V2, V3, V4, V7).

## Related

- [pen-test-checklist.md](./pen-test-checklist.md) — the categories exercised here.
- [docs/security/threat-register.md](./threat-register.md) — where an accepted
  risk from this report belongs.
- [container-hardening.md](./container-hardening.md), [tls-enforcement.md](./tls-enforcement.md),
  [secure-cookies.md](./secure-cookies.md) — the controls this exercise attacked.
- [docs/guides/error-handling.md](../guides/error-handling.md) — the envelope F-04 bypasses.
- Roadmap Issue 217.
