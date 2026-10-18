# Secure Cookie Configuration

A session cookie is a bearer credential that the browser attaches automatically.
The application never gets to choose whether it is sent — the browser does, from
attributes set once, at issuance. So the rule:

**Every cookie Verixa sets is defined in one file, with `Secure`, the narrowest
`Path` that works, no `Domain`, and `HttpOnly` unless the cookie's whole purpose
requires script to read it.**

Roadmap Issue 214. Implementation: `packages/sessions/infrastructure/http/cookie-config.ts`,
exported from `@verixa/sessions`. The policy lives in the sessions package
rather than in `apps/api` because which cookie is `HttpOnly` is a property of the
session model, not of whichever framework happens to carry it.

## The audit this doc is the output of

Issue 214 asks for every cookie-setting call site to be reviewed. Findings, as
of this PR:

| Where                                      | Sets a cookie?                                          |
| ------------------------------------------ | ------------------------------------------------------- |
| `apps/api/src/routes/auth.ts`              | No. `/auth/login` returns the user and no token at all. |
| `apps/api/src/routes/verification.ts`      | No. Tokens travel in the request body.                  |
| `apps/api/src/plugins/security-headers.ts` | No. Sets `Strict-Transport-Security`, `Location` only.  |
| `packages/sessions/**`                     | The policy itself. No route calls it yet.               |

That is the honest state: **the platform has no session cookie on the wire
today**, because the HTTP layer that would issue one is still unwired — login
returns a user, `apps/api` lists `@verixa/sessions` as a dependency but no module
in it imports the package, and `IssueSession` is exercised only by that
package's own tests. Phase 05's session routes and Issue 205's CSRF middleware
are the two callers that will exist.

Writing the policy now, with tests, is the useful form of this issue: the audit
is what fixes the attributes _before_ a route ships them, and a route that
copies `reply.header("set-cookie", …)` out of a Stack Overflow answer is the
thing this prevents. The wire-level tests in
`packages/sessions/infrastructure/http/cookie-config.spec.ts` therefore exercise
a `node:http` server that writes the policy's own output, rather than pretending
a login route exists.

## The two cookies

```text
Set-Cookie: verixa_refresh=R-1; Path=/auth/refresh; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax
Set-Cookie: verixa_csrf=C-1; Path=/; Max-Age=3600; Secure; SameSite=Lax
```

|            | `verixa_refresh`              | `verixa_csrf`       |
| ---------- | ----------------------------- | ------------------- |
| Holds      | Refresh token (bearer secret) | Double-submit token |
| `HttpOnly` | Yes                           | **No** — see below  |
| `Secure`   | Yes, always                   | Yes, always         |
| `SameSite` | `Lax`                         | `Lax`               |
| `Path`     | `/auth/refresh`               | `/`                 |
| `Domain`   | Absent (host-only)            | Absent (host-only)  |
| `Max-Age`  | Session lifetime              | Shorter, by caller  |

`sessionCookies({ refreshToken, csrfToken, sessionMaxAgeSeconds, csrfMaxAgeSeconds })`
returns both strings as one array, and `clearedSessionCookies()` returns the pair
that deletes them. A route gets both or neither: issuing the session and
forgetting the CSRF token produces a client that can log in and cannot make a
single state-changing request.

## One attribute at a time, with the alternative that was rejected

### `HttpOnly`

The refresh token is a long-lived bearer credential. Readable by script, one XSS
anywhere on the origin exfiltrates it, and unlike an access token it is replayable
for weeks and survives rotation of the access token it was issued alongside.
`HttpOnly` makes theft require a network position or a stolen profile rather than
one injected `<script>`.

`HttpOnly` is not a defense against XSS-driven _request forgery_ — a script on
the origin can still make the browser send the cookie. That is what `SameSite`
and the CSRF token are for, and pretending otherwise is how teams end up with
`HttpOnly` and no CSRF protection at all.

### The one exception: the CSRF token is script-readable on purpose

A double-submit CSRF token is not a secret from the page it was issued to. Its
entire job is to be read back by JavaScript and echoed into a header (or a form
field), so the server can check that whoever sent the request could also read
this origin's cookies. `HttpOnly` on that cookie would not harden anything — it
would break the mechanism, and the first developer to hit it would "fix" the
symptom by deleting the check.

The exception is tolerable because the value grants nothing by itself. The
credential is `verixa_refresh`, and it stays `HttpOnly`; an attacker who reads
the CSRF token still has to induce a request the browser will not make
cross-site. This is the row in the table above that a reviewer of Issue 205
should stop on, and it is the reason `docs/security/secure-cookies.md` exists
separately from the CSRF design doc.

### `Secure`

Sent over TLS only, and — because a `Secure` cookie is refused by a browser that
does not consider the origin trustworthy — it is also the attribute that forces
the TLS posture in [tls-enforcement.md](./tls-enforcement.md) to be real rather
than aspirational.

`Secure` is **not configurable**, including in development. The reason is that
"this environment is development" is a claim a deployment makes about itself, and
the failure mode of a flag that can be off is a production stack with
`COOKIE_SECURE=false` left over from a `docker-compose.override.yml` — a session
cookie readable by everyone on the network, reported as nothing. The visible
cost is a developer on `http://dev-box.lan:3000` whose cookie is dropped; the fix
is `http://localhost:3000` or a locally trusted certificate (`mkcert`), not the
flag. `packages/sessions` does not read `NODE_ENV` for cookies at all, which is
the opposite of the HSTS decision — pinning `localhost` is an afternoon of lost
work, while a `Secure` cookie that will not store is a red line in the devtools
cookie panel.

### `SameSite=Lax`, not `Strict`, and never `None`

`SameSite` is the browser-enforced half of CSRF defense; the token is the
application-enforced half. Both, because they fail differently: `SameSite` covers
requests the application forgot to check, and the token covers the case
`SameSite` cannot see (a same-site request forged by script on the origin).
Defense in depth, not redundancy.

- `Lax` omits the cookie from every cross-site _sub-request_ — an image, a form
  `POST`, a fetch from `evil.com` — which is the shape of a CSRF attack.
- `Strict` additionally omits it from a top-level navigation _into_ the app: a
  link clicked from an email, or the redirect back from an identity provider.
  The refresh that follows that arrival is the one thing the flow needs, so
  `Strict` produces "you were signed out while you were reading your mail".
  Rejected on usability, not safety. A deployment that never server-renders and
  wants `Strict` should change this one line, in this one file, and say so in
  its own docs.
- `None` is not offered. It means "send this cross-site", which for a refresh
  token is a different product, and it requires `Secure` in every browser that
  implements it. `serializeCookie` throws rather than emit `SameSite=None`
  without `Secure`, because that combination is _silently discarded_ — a cookie
  that never stores produces an infinite "not logged in" loop with no error
  anywhere.

### `Path=/auth/refresh` for the credential

`Path` is not a defense against XSS — a script on any page of the origin can
still issue the request that carries the cookie. What it does control is _when
the value leaves the browser at all_. Scoped to one endpoint, the refresh token
is absent from every other request this tab makes: other paths, other services
on the same host, and the access logs of anything that ever sees them. With
`Path=/` the credential is in the `Cookie` header of the request for the
marketing page, the metrics scrape, and the misconfigured legacy app on `/admin`.

`/auth/refresh` is the only route that reads it. Narrowing the scope is free at
issuance and expensive to retrofit, so the narrow value is the default.

### No `Domain`, ever

`CookieAttributes` has no `domain` field. Omitting `Domain` yields a **host-only**
cookie: sent to `api.example.com`, never to `staging.example.com`, never to
`whatever-our-CDN-team-creates-next-quarter.example.com`.

Setting `Domain=example.com` is the standard way to lose a session cookie to a
subdomain you do not operate, and the loss is invisible: the cookie is stored
under a broader scope, and any XSS or DNS-rebind on any subdomain can read it.
The cross-subdomain SSO use case that justifies `Domain` cookies is a different
design (Issue 214 does not have it), and would need a documented threat model,
not a config key.

### Prefixes: `__Host-` rejected, `__Secure-` available

Browsers honour name prefixes as stronger contracts than attributes:
`__Host-` requires `Secure`, **`Path=/`**, and no `Domain`, and refuses to be set
or overwritten by anything but an exact-scope match. `__Secure-` requires
`Secure` only.

`__Host-` is the right answer for most cookies and the wrong answer here, for one
reason: it mandates `Path=/`, which gives back the scope that
`Path=/auth/refresh` buys. A name an attacker on a subdomain cannot overwrite is
a smaller win than a refresh token that is absent from 95% of the origin's
requests. Adding it would be free but restates a guarantee that has no way to be
made wrongly here: neither factory accepts an input that controls `Secure`, so
there is no call site for the browser to overrule. If Issue 205's CSRF token ends up
needing tamper-resistance from a subdomain, `__Host-verixa_csrf` is the change to
make — its `Path=/` is already the policy for that cookie.

### `Max-Age`, and `Expires` only when clearing

Lifetimes are passed in seconds from `SessionExpiryPolicy` (`refreshTokenTtlMs`,
default 30 days), and `Max-Age` is what a browser that supports both prefers.
`serializeCookie` rejects a fractional, negative, `NaN` or infinite `Max-Age`,
because those serialize to a header the engine discards without a word — the
realistic way to arrive there is a lifetime computed by dividing milliseconds by
something that is not 1000.

`Date.now()`-relative `Expires` is not used: two clocks that disagree (client,
proxy logs) make an absolute expiry a worse statement than a duration.

### `Partitioned` (CHIPS) is supported and unused

`CookieAttributes.partitioned` emits `Partitioned` for embedded contexts, and
`serializeCookie` refuses it without `Secure` for the same silent-discard reason
as `SameSite=None`. Neither session cookie sets it — Verixa's API is not meant to
be framed inside another site's page, and a cookie that works in an iframe is a
cookie that can be. The field exists so that if an embed use case ever arrives, it
is one attribute, not a serialization rewrite.

## Clearing a cookie is a match, not a delete

A cookie is identified by the tuple **(name, `Domain`, `Path`)**. Sending
`Expires=Thu, 01 Jan 1970` with `Path=/` does nothing to a cookie stored under
`Path=/auth/refresh` — it creates a second, empty, already-expired cookie and
leaves the real one in the jar. This is the bug that turns logout into "logged
out until the refresh token comes back on the next request", and it is why
`expireCookie()` derives the clear instructions from the original attributes
instead of anyone writing them out again:

```text
Set-Cookie: verixa_refresh=; Path=/auth/refresh; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax
Set-Cookie: verixa_csrf=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; SameSite=Lax
```

Both `Max-Age=0` and the epoch `Expires` go out: `Max-Age` is what current
engines prefer, the absolute date is what a client implementing only the older
behaviour needs. `Partitioned` is carried through by the same matching rule.

## Nothing sensitive is client-readable

Beyond the CSRF token being deliberately readable, no session data goes in a
cookie: no user id, no role, no tenant, no expiry, no claims. The refresh cookie
holds one opaque token, which is meaningless without the database behind it, and
the access token lives in memory or in the Authorization header, never in a
cookie the browser will volunteer.

The reason this is a rule rather than an observation: cookies are visible to
every piece of script on the origin, logged by every proxy, and shipped to every
request matching their scope. A cookie is a broadcast. Anything stored in one
should be assumed published — see
[docs/security/token-storage.md](./token-storage.md) for the corresponding rule
about the server side, where the _stored_ copy is a hash.

## Values are validated on the way out

`serializeCookie` refuses a name, value or path outside RFC 6265's character
sets. Not decoration:

- A `;` in a value ends the attribute list early. `verixa_refresh=abc; HttpOnly`
  arriving through a value the application did not generate becomes two cookies,
  the second named `HttpOnly` — cookie injection, and the same trick a `Path`
  would allow.
- A CR or LF is response splitting, which Node's HTTP serializer will refuse to
  write, but a guard saved by the layer below it is a guard nobody reading this
  file will know exists.
- `=` stays allowed (base64 padding), which is why the value pattern is written
  as the five ranges the RFC lists rather than a hand-built set of separators —
  the ranges make `=` visible as permitted instead of accidentally excluded.

The offending value is never quoted back into the thrown message, because the
message is what a log will carry and the value is what failed the injection
check.

## What is deliberately not here

- **The routes.** No login, refresh or logout handler sets these headers yet.
  Wiring the policy into `apps/api` is Phase 05's session routes and Issue 205;
  both should call `sessionCookies()` / `clearedSessionCookies()` and put the
  returned array in `set-cookie` without touching attributes.
- **CSRF middleware.** The double-submit comparison, the header name, and the
  token's entropy are Issue 205's. This file only fixes what the cookie carrying
  it looks like.
- **Cookie _reading_.** Parsing `Cookie:` request headers is an HTTP-layer
  concern; nothing in this package needs it.
- **`Set-Cookie` chunking, `SameSite` for non-browser clients, and third-party
  cookie blocking.** The first is the framework's; the second matters for
  mobile/CLI clients that will not store a cookie at all (they should use the
  header-based flow); the third is a product decision about what happens when a
  browser refuses to store cookies on a framed page — the answer here is "the
  embed case is out of scope", not "so we drop `Secure`".
- **Issue 203's other headers and Issue 213's redirect.** Different files,
  different concerns; see [tls-enforcement.md](./tls-enforcement.md).

## Adding a cookie: the checklist

1. Is it a credential, a CSRF token, or a preference? The first two are taken.
2. Add a named factory in `cookie-config.ts` that returns `CookieAttributes`
   without any input controlling `Secure` or `HttpOnly`.
3. Give it the narrowest `Path` that works, and no `Domain`.
4. Add it to `sessionCookies()` / `clearedSessionCookies()` if it belongs to a
   session — logout must clear every cookie a login sets, and the pairing is
   what makes forgetting it a compile-time problem rather than a support ticket.
5. Test the exact serialized string, the cleared string, and one wire-level
   assertion that the header arrives as its own cookie.

## Related

- [docs/security/tls-enforcement.md](./tls-enforcement.md) — why `Secure` is not
  a development-only concern, and the local-dev origins that work.
- [docs/security/token-storage.md](./token-storage.md) — the server-side half:
  what is stored once the token arrives.
- [docs/security/threat-model-sessions.md](./threat-model-sessions.md) — the
  refresh-token rotation and reuse-detection threats these attributes narrow.
- [docs/security/authentication-flows.md](./authentication-flows.md) — the login
  and refresh flows whose responses will carry these cookies.
- Roadmap Issue 205 (CSRF middleware), Issue 213 (TLS/HSTS), Issue 219 (ASVS
  V3 session management, where these rows get assessed against the standard).
