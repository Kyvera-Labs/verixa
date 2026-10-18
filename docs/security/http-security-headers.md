# HTTP Security Headers

Every response this API produces carries the same header set, and it is
configured in exactly one place: `apps/api/src/plugins/security-headers.ts`,
registered by `buildApp()` before any route.

That single fact is the design. Headers are a property of the _response_, not of
the handler that made it, so a per-route header is a per-route decision that has
to be repeated correctly forever. Registering once at the composition root makes
"all routes are covered" true by construction — including the routes later
phases add and the 404 that no route handles.

## What each header buys

| Header                              | Value                                                                             | Attack it mitigates                                                                                                                                          |
| ----------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Content-Security-Policy`           | `default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` | Injected script executing at all. With no document to render, the strongest policy is the one that allows nothing.                                           |
| `X-Frame-Options`                   | `DENY`                                                                            | Clickjacking: a hostile page frames `POST /auth/login` under a transparent overlay and the victim's own click lands on it.                                   |
| `X-Content-Type-Options`            | `nosniff`                                                                         | MIME sniffing: a body served as `text/plain` gets reinterpreted as HTML and executes in this origin. The main path here is an uploaded or echoed payload.    |
| `Referrer-Policy`                   | `no-referrer`                                                                     | Referrer leakage: a URL containing a verification request id or a reset token is handed to every third party the next page loads.                            |
| `Strict-Transport-Security`         | `max-age=31536000; includeSubDomains`                                             | TLS stripping: a hostile access point downgrades the connection and reads the session cookie or bearer token in cleartext.                                   |
| `X-Powered-By`                      | removed                                                                           | Stack fingerprinting: the response names its technology before anyone has probed it.                                                                         |
| `X-Permitted-Cross-Domain-Policies` | `none`                                                                            | Legacy Flash `crossdomain.xml`, which let a policy-aware client on _another_ origin read this origin's responses.                                            |
| `X-DNS-Prefetch-Control`            | `off`                                                                             | The browser pre-resolving hostnames named in a response, leaking internal names to the resolver before any request is made.                                  |
| `X-Download-Options`                | `noopen`                                                                          | IE opening a downloaded response _in_ the originating site's context, so the file inherits this origin's permissions.                                        |
| `X-XSS-Protection`                  | `0`                                                                               | The legacy IE Chrome XSS auditor, which rewrites pages to highlight matches and can itself be turned into a data leak and a CSP bypass. `0` switches it off. |
| `Origin-Agent-Cluster`              | `?1`                                                                              | Process clustering: two origins sharing a renderer process can reach each other's state.                                                                     |

`X-XSS-Protection` is the one helmet would send whether or not it appeared in
`SECURITY_HEADERS`, and it is written down anyway. The object is meant to be the
whole policy: a header that arrives only because a dependency defaults it is a
header a reviewer cannot find, and the first thing someone does when a browser
misbehaves is delete the headers they cannot explain.

Two of these are worth more explanation than a table row, because their value is
a choice rather than an obvious default.

### CSP is `default-src 'none'`, not `'self'`

`'self'` is the usual starting point and it is the wrong one here. It permits
script loaded from this origin, which is exactly what an attacker wants once
they have any same-origin file write, an open redirect into a JSONP-style
endpoint, or a dependency that injects into the page. `'none'` costs nothing
because no response here is a document — every route answers
`application/json`, which a browser fetches but never renders.

It is also the cheap direction to have started in. Relaxing a policy is a
decision made later with a specific need in front of you; tightening one that
shipped at `'unsafe-inline'` is a migration across every client that came to
depend on it.

`useDefaults: false` is set because helmet's own baseline is written for
server-rendered pages: it carries `script-src 'self'` and an inline-style
allowance, both meaningless for an API and both things a reviewer would have to
explain away.

### HSTS has no `preload`

`preload` is not a header value so much as a submission to a browser-shipped
list, and that list is awkward to leave: once in, every hostname under the
domain must serve HTTPS forever. Provisioning hosts, staging boxes, and any
future plaintext-HTTP internal subdomain break the moment the list entry is
consumed. The directive is owned by Issue 213, along with the TLS-termination
topology the decision depends on — the reverse proxy, not this repository, is
where that is settled.

The header is sent on plaintext local HTTP too, rather than being gated by
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

Nonce-based CSP is likewise deferred to Issue 212, which owns the first HTML
surface (Swagger UI, Issue 237). Adding a `script-src` with a per-request nonce
now would mean a nonce that nothing validates and a policy for pages that do not
exist yet.

## Opting out

No route opts out, and the bar for adding one is a paragraph here.

The specific shape to refuse: a route registering `onSend` that overwrites one of
these headers, or a child scope calling `app.register(helmet, ...)` again with
different options. Both work, both are silent, and the second one is the
trap — `@fastify/helmet` is `fastify-plugin`-wrapped and its hook is inherited by
child scopes, so a re-registration inside a scope doesn't scope the override to
that prefix the way people expect; it competes with the root policy for every
response. `apps/api/src/plugins/security-headers.spec.ts` pins the inherited case
(`/__encapsulated-probe__`) because that is the failure a future plugin author
is most likely to introduce.

If a header genuinely must differ for one endpoint, the right move is to say so
here with the attack it now tolerates, so the deletion is someone else's
reviewed decision rather than an unrecoverable accident.
