# HTTP Security Headers

Every response this API produces carries the same baseline header set, and all
of it is declared in one module: `apps/api/src/plugins/baseline-response-headers.ts`,
registered by `buildApp()` before any route.

Its neighbour, `apps/api/src/plugins/security-headers.ts`, owns the transport
half of the same story — the `Strict-Transport-Security` pin and the
HTTP-to-HTTPS redirect — because those depend on where TLS terminates and on
validated per-environment configuration. The split is enforced by
configuration rather than by convention: the baseline module sets `hsts: false`,
so it cannot emit the header the other module is responsible for. One header,
one owner.

That single declaration is the design. Headers are a property of the _response_,
not of the handler that made it, so a per-route header is a per-route decision
that has to be repeated correctly forever. Registering once at the composition
root makes "all routes are covered" true by construction — including the routes
later phases add and the 404 that no route handles.

## What each header buys

| Header                              | Value                                                                             | Attack it mitigates                                                                                                                                              |
| ----------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Content-Security-Policy`           | `default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` | Injected script executing at all. With no document to render, the strongest policy is the one that allows nothing.                                               |
| `X-Frame-Options`                   | `DENY`                                                                            | Clickjacking: a hostile page frames `POST /auth/login` under a transparent overlay and the victim's own click lands on it.                                       |
| `X-Content-Type-Options`            | `nosniff`                                                                         | MIME sniffing: a body served as `text/plain` gets reinterpreted as HTML and executes in this origin. The main path here is an uploaded or echoed payload.        |
| `Referrer-Policy`                   | `no-referrer`                                                                     | Referrer leakage: a URL containing a verification request id or a reset token is handed to every third party the next page loads.                                |
| `Strict-Transport-Security`         | from validated config: `max-age=…`, then `includeSubDomains`, then `preload`      | TLS stripping: a hostile access point downgrades the connection and reads the session cookie or bearer token in cleartext. Owned by Issue 213, not by this set.  |
| `X-Powered-By`                      | removed                                                                           | Stack fingerprinting: the response names its technology before anyone has probed it.                                                                             |
| `X-Permitted-Cross-Domain-Policies` | `none`                                                                            | Legacy Flash `crossdomain.xml`, which let a policy-aware client on _another_ origin read this origin's responses.                                                |
| `X-DNS-Prefetch-Control`            | `off`                                                                             | The browser pre-resolving hostnames named in a response, leaking internal names to the resolver before any request is made.                                      |
| `X-Download-Options`                | `noopen`                                                                          | IE opening a downloaded response _in_ the originating site's context, so the file inherits this origin's permissions.                                            |
| `X-XSS-Protection`                  | `0`                                                                               | The legacy IE and Chrome XSS auditor, which rewrites pages to highlight matches and can itself be turned into a data leak and a CSP bypass. `0` switches it off. |
| `Origin-Agent-Cluster`              | `?1`                                                                              | Process clustering: two origins sharing a renderer process can reach each other's state.                                                                         |

`X-XSS-Protection` is the one helmet would send whether or not it appeared in
`BASELINE_RESPONSE_HEADERS`, and it is written down anyway. The object is meant
to be the whole policy: a header that arrives only because a dependency defaults
it is a header a reviewer cannot find, and the first thing someone does when a
browser misbehaves is delete the headers they cannot explain.

Three of these are worth more explanation than a table row, because their value
is a choice rather than an obvious default.

### CSP is `default-src 'none'`, not `'self'`

`'self'` is the usual starting point and it is the wrong one here. It permits
script loaded from this origin, which is exactly what an attacker wants once
they have any same-origin file write, an open redirect into a JSONP-style
endpoint, or a dependency that injects into the page. `'none'` costs nothing
because almost no response here is a document — every route answers
`application/json`, which a browser fetches but never renders. The one that
isn't has its own policy, below.

It is also the cheap direction to have started in. Relaxing a policy is a
decision made later with a specific need in front of you; tightening one that
shipped at `'unsafe-inline'` is a migration across every client that came to
depend on it.

`useDefaults: false` is set because helmet's own baseline is written for
server-rendered pages: it carries `script-src 'self'` and an inline-style
allowance, both meaningless for an API and both things a reviewer would have to
explain away.

### `/docs` gets its own policy

The OpenAPI documentation UI is the only response here a browser renders, so
`default-src 'none'` would leave it blank. It is served under
`DOCS_CONTENT_SECURITY_POLICY`, which is defined next to the baseline policy
rather than somewhere the exception is easy to miss.

It is **tighter** than `@fastify/swagger-ui`'s own `staticCSP: true` policy,
directive by directive, and it is worth keeping the reasons in one place:

- `script-src 'self'` with no `'unsafe-inline'`. The served page loads three
  external `<script src>` tags and contains no inline script, because
  `staticCSP` is what makes swagger-ui emit its configuration as an external
  `swagger-initializer.js` rather than an inline block. Drop that option and
  this policy breaks the page — the trade is deliberate.
- `style-src 'self'`, where swagger-ui also allows `https:`. A remote stylesheet
  is UI redressing: enough to move a "Try it out" button under the cursor of
  whoever is about to execute a request against a live environment. The CSS here
  is served from `/docs/static` and declares no webfont, so nothing needs the
  wider source.
- `img-src 'self' data:`, dropping swagger-ui's `validator.swagger.io`. Loading
  an image from that origin hands this deployment's spec to a third party, and
  the spec names every endpoint this API has. `data:` stays because the bundle's
  icons are inlined as SVG data URIs in its stylesheet, and CSP checks a
  stylesheet's `url()` fetches against `img-src`.
- `base-uri 'none'` and `frame-ancestors 'none'` instead of swagger-ui's
  `'self'`, matching the baseline. The page uses neither.
- `font-src` omitted entirely, so it inherits `default-src 'self'`. A directive
  for a resource type nothing loads is one more value without a reason.
- `upgrade-insecure-requests` dropped. No directive here permits an `http:`
  origin, so it could only rewrite a request the policy already refuses.

Loading the page in a real browser under this policy reports one violation: the
bundle applies a single inline style at first render and CSP blocks it. The
specification still loads, every operation still expands, and the Authorize
modal still opens. The same violation, with the same `sha256` hash, appears
under swagger-ui's own `staticCSP: true` — which also has no `'unsafe-inline'`.
So `'unsafe-inline'` is not what makes this UI work, and adding it would only
widen the policy: a style written in markup can restyle the page, which is the
same redressing argument as the remote stylesheet above. If that one blocked
declaration ever turns out to matter, the fix is a hash or a nonce for it, and
Issue 212 is where nonce plumbing belongs.

`/docs/openapi.json` is registered outside the documentation plugin and keeps
the baseline `default-src 'none'`, which is the shape of the exception: it
applies to what a browser renders, not to a URL prefix.

### `Strict-Transport-Security` has one owner

`hsts: false` in `BASELINE_RESPONSE_HEADERS` is not "HSTS is off". It is this
module declining to have an opinion about a value it cannot know: the pin's
`max-age`, `includeSubDomains` and `preload` come from the environment
(`DEFAULT_HSTS_MAX_AGE_SECONDS` is one year, `MAX_HSTS_MAX_AGE_SECONDS` two),
and they are sent by an `onRequest` hook that also decides whether to redirect
plaintext traffic. Emitting a second pin from helmet would make the header's
final value depend on hook ordering — not a property anyone reviewing a TLS
decision can check locally.

`preload` in particular is not a header value so much as a submission to a
browser-shipped list, and that list is awkward to leave: once in, every hostname
under the domain must serve HTTPS forever. Provisioning hosts, staging boxes,
and any future plaintext-HTTP internal subdomain break the moment the list entry
is consumed — which is why it is a config flag defaulting to off rather than
something a baseline policy sets for everyone.

The pin is sent on plaintext local HTTP too, rather than being gated by
`request.protocol`. Browsers ignore HSTS on a non-secure origin, so development
is unaffected, and gating it would make the policy depend on `X-Forwarded-Proto`
— a header a misconfigured deployment can lie about.

## What this is not

Response headers are defense in depth, not access control. `nosniff` does not
make an unauthenticated endpoint safe; CSP does not stop a route that returns
data it should not have returned. A header raises the cost of a whole class of
client-side exploitation and nothing more, and any threat model that depends on
one for authorization is wrong.

The same reasoning is why the cross-origin trio is **not** configured here.
`Cross-Origin-Resource-Policy`, `Cross-Origin-Opener-Policy` and
`Cross-Origin-Embedder-Policy` answer "which other origins may read or relate to
this response" — precisely the question Issue 204 (CORS) answers with an
environment-specific allowlist. A blanket `same-origin` here would pre-empt that
work, and the failure mode is a confusingly blocked front end, not a blocked
attack. If 204 ends up single-origin, these are worth enabling alongside it, and
they belong in that change.

## Opting out

The baseline applies to every response, and the bar for a route that does not
carry it is a section in this document. `/docs` is the one that has cleared it.

The specific shape to refuse is a hook that overwrites one of these headers, or a
child scope calling `app.register(helmet, ...)` again with different options.
Both look like they work and neither is reliable. `@fastify/helmet` is
`fastify-plugin`-wrapped, so its hook is inherited by child scopes; a
re-registration inside a scope does not scope the override to that prefix the way
people expect — it competes with the root policy for every response.

A second trap is ordering, and `/docs` hit it. An `onSend` hook added at the root
runs _before_ the hooks of an encapsulated child scope, so it cannot override a
header that a plugin inside that scope sets in its own `onSend`: the child's
value wins and the root's write is discarded. That is why the documentation
policy is passed to the plugin's own `staticCSP` option instead of being written
by a hook here — the failure mode of the hook version is not an error but a
header that silently keeps its old value, on exactly the one response the
exception exists for.

`apps/api/src/plugins/baseline-response-headers.spec.ts` pins both cases: a route
in an encapsulated scope (`/__encapsulated-probe__`) still gets the baseline, and
the documentation routes get the documented exception rather than whatever
ordering happens to produce.

If a header genuinely must differ for one endpoint, the right move is to say so
here with the attack it now tolerates, so the deletion is someone else's
reviewed decision rather than an unrecoverable accident.
