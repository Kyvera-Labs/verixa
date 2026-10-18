# HTTP Security Headers

Every response this API sends carries a small set of headers that tell a
browser how to treat the bytes it is about to receive. They are cheap, they are
the last line of defence for a mistake made somewhere else, and — unlike most
controls in this repository — they are only useful if they are on **every**
response. That is why they live in one hook in one file rather than in the
routes that care about them.

Implementation: `apps/api/src/plugins/security-headers.ts` (hooks and policy
strings), `apps/api/src/http/html.ts` (the only thing that renders a document),
`apps/api/src/routes/csp-report.ts` (violation reports). Tests:
`apps/api/src/plugins/security-headers.spec.ts`, `apps/api/src/http/html.spec.ts`,
`tests/integration/csp-report-route.spec.ts`.

## What is set

| Header                    | Value                                                               | Applies to |
| ------------------------- | ------------------------------------------------------------------- | ---------- |
| `Content-Security-Policy` | nonce-based policy for HTML, `default-src 'none'` for anything else | all        |
| `X-Content-Type-Options`  | `nosniff`                                                           | all        |
| `Referrer-Policy`         | `no-referrer`                                                       | all        |
| `X-Frame-Options`         | `DENY`                                                              | all        |

`X-Frame-Options` and `X-Content-Type-Options` are the older half of jobs that
CSP also does (`frame-ancestors` and a correct `Content-Type` respectively).
They are kept because a browser that ignores CSP is exactly the browser that
still needs to be told.

## The two policies

**For documents this server renders:**

```
default-src 'self';
script-src 'self' 'nonce-<per-request value>';
style-src 'self';
img-src 'self';
font-src 'self';
object-src 'none';
base-uri 'none';
frame-ancestors 'none';
form-action 'self';
report-uri /csp-report
```

**For everything else** — JSON, plain text, an error page nobody styled:

```
default-src 'none';
base-uri 'none';
frame-ancestors 'none';
form-action 'none';
report-uri /csp-report
```

The second one is a fail-closed default, and it is the reason the policy is
chosen in an `onSend` hook rather than an `onRequest` one: a route picks its
content type while handling the request, so the header has to be decided after
that. A route that forgets to declare a content type gets `'none'`, not
`'self'`. If something has gone wrong badly enough that the API is returning
HTML, that is the moment the policy is worth having.

One deliberate exception to "every response": if a route sets its own
`Content-Security-Policy`, the hook leaves it alone. Overriding a policy a
developer wrote on purpose would make the header impossible to reason about.

## Why nonces, and what `'unsafe-inline'` actually costs

`'unsafe-inline'` in `script-src` does not widen a policy, it cancels it.
CSP's core XSS defence is that an injected `<script>alert(1)</script>` is not on
the allowlist — and `'unsafe-inline'` permits precisely that shape: every inline
script, including the attacker's. A page can carry a strict-looking
`default-src 'self'` and still be fully exploitable through `script-src
'unsafe-inline'`, which is how this stays a footgun worth writing about.

A nonce is the same convenience with the protection intact. The browser runs an
inline script only if it carries the value this response generated, so an
injected fragment cannot execute unless the attacker can already read the
response — at which point the XSS did not need CSP to fail.

`'unsafe-eval'` is absent for the analogous reason: it lets a string become
code, so every place an attacker can steer a string is a place they can steer
execution. Nothing here needs it. If a dependency demands it, that is a
decision to review, not a flag to flip.

### The rules that make a nonce work

1. **Generated per request, never per process.** `randomBytes(16)` in
   base64url, once in the `onRequest` hook. A nonce that is constant across
   responses is a static string an attacker hardcodes, which makes it exactly as
   useful as `'unsafe-inline'`. Its whole security value is unpredictability.
2. **Read it from `request.cspNonce`.** It is a decorated request property, not
   an argument, so a route cannot forget to thread it into what it renders.
3. **Render through `renderHtmlDocument`.** It puts the nonce on the
   `<script>` element it emits. A hand-written HTML string in a route handler
   will not, and the page will render while silently doing nothing.
4. **A nonce covers inline scripts only.** An external file (`src="…"`) is not
   nonce-checked; it is governed by `'self'` and the rest of the allowlist. So
   `'nonce-…'` does not exempt a hosted file, and adding one is a policy change
   — see below.
5. **Everything else still needs escaping.** The nonce authorizes _execution_,
   it does nothing about a value that ends its own element: a `</title>` in a
   page title, or a quote in an attribute. `http/html.ts` escapes on output
   because the two mechanisms are not interchangeable.

## Adding a new script source — the process

An HTML surface that needs JavaScript from somewhere other than this origin
(the Swagger UI of Issue 237 being the obvious one) goes through this list, in
this order:

1. **Can it be served from this origin instead?** Copying a dependency into the
   build removes the question permanently. Prefer it.
2. **Does it have to run inline?** Then it belongs in a file the page loads, or
   in a nonce-carrying script emitted by `renderHtmlDocument`. Do not add
   `'unsafe-inline'` to make a static file work.
3. **It must come from a third-party origin.** Add the **minimum** origin to
   `script-src` in `contentSecurityPolicyForHtml`, not a wildcard and not a
   scheme-only pattern. `https://cdn.example.net` — not `*.example.net`, and
   never `https:`.
4. **Pin what you can.** A versioned URL is not integrity, and
   `integrity="sha384-…"` (SRI) is what actually binds a CDN file to a known
   bytes. Add it whenever the source is not this origin.
5. **Watch the interaction with `'nonce-…'`.** Once a policy contains a nonce
   or a hash, browsers ignore host allowlists in `script-src` entirely if
   `'strict-dynamic'` is present. This policy does not use
   `'strict-dynamic'`, so allowlisted hosts still apply — but a future change
   that adds it would silently stop the CDN entry working, and that is the kind
   of breakage only a test notices. Keep
   `plugins/security-headers.spec.ts` asserting the exact directive list.
6. **Send the change with a test.** The spec asserts both that the nonce is
   present in `script-src` and that no `unsafe-inline`/`unsafe-eval` appears. If
   a change makes either assertion awkward, the change is the problem.

The same discipline applies to `style-src` for a docs page that wants CSS from
a CDN: it is a separate directive, it needs its own change, and `'unsafe-inline'`
there is a smaller problem than in `script-src` but still a real one (an
attacker who can inject a style can exfiltrate values through attribute
selectors).

## Violation reports

`report-uri /csp-report` makes a blocked script leave a trace instead of
quietly not running. That is the difference between a policy that can be
maintained and one that can only be loosened: without reports, the first person
to notice a tightened `script-src` is a user with a half-working page, and the
fix is always the permissive one.

What the endpoint does (`routes/csp-report.ts`):

- Accepts `application/csp-report` — a media type Fastify has no built-in
  parser for, so it is registered here. Without that parser the channel answers
  `415` and nothing ever arrives, invisibly. Ordinary `application/json` works
  too, which is how a person with `curl` tests it.
- Requires `csp-report.document-uri`, and **tolerates unknown fields** — the
  only route in the API that does. Everywhere else unknown properties are
  rejected, because a caller who thinks it set `status: "active"` must be told
  it did not. Here the caller is a browser engine emitting fields we do not
  model (`script-sample`, per-engine variations), and rejecting a report for one
  of those throws away the evidence.
- Logs a fixed projection: `documentUri`, `directive`, `blockedUri`,
  `disposition`, `sourceFile`, `statusCode`. Never the raw body.
  `original-policy` in particular is the policy as the browser saw it — the
  largest attacker-influenced string in the payload, on an unauthenticated
  endpoint, and a log line built field by field cannot echo a forged one back.
- Answers `204`. Browsers ignore the response body.
- Caps the body at 16 KiB (`bodyLimit`), where Fastify's default is 1 MiB, and
  returns `413` above it.

Reports are logged, not stored. Turning them into a queryable signal is
Phase 11's security-monitoring question, not this endpoint's.

## Current state, stated plainly

**There is no HTML surface in production today.** The API serves JSON,
`/health`, and `/.well-known/security.txt` as `text/plain`. The only route in
this repository that renders an HTML document is a probe registered by
`plugins/security-headers.spec.ts` — which is what makes the nonce assertions
testable before the Swagger UI exists.

That ordering is intentional. A baseline policy installed _after_ the first HTML
page tends to permit whatever that page needs, and inline scripts are always
already there. Installing the seam first means the first real HTML route has to
thread a nonce to work at all.

**Not in this document, deliberately:**

- `Strict-Transport-Security` and TLS termination — Issue 213.
- The `Report-To` / `Reporting-Endpoints` replacement for `report-uri`.
  `report-uri` is deprecated-but-supported by every engine that matters here,
  and the CSP3 reporting headers are a separate change with a separate payload
  format.
- `Permissions-Policy`, `Cross-Origin-Opener-Policy` and the other CO\* headers.
  They matter for pages with real third-party content; adding them to a JSON
  API now would be decoration.
- `/csp-report` authentication. It is unauthenticated because a browser cannot
  be given a credential to send a violation report, and the worst it can be used
  for is log noise — which is why the body is size-capped and the logged fields
  are a fixed list.
