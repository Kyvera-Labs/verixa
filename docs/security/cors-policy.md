# CORS Policy

A browser will not let a page at one origin read a response from another origin
unless that other origin says so. That rule — the same-origin policy — is the
single most important boundary protecting an authenticated API from a hostile
web page, and CORS is the mechanism by which an origin gives it up, selectively,
for named callers.

So the policy is the security control. There is no algorithm underneath it: the
only question that matters is which origins appear on the allowlist, and the
answer has to be specific enough that an attacker who can register a domain
cannot get onto it by accident.

Roadmap Issue 204. Implementation: `apps/api/src/plugins/cors.ts`, wired by
`buildApp` before any route and driven by `@verixa/config`
(`CORS_ALLOWED_ORIGINS`, `CORS_ALLOW_CREDENTIALS`). Environment template:
`.env.example`.

## What the policy is

Two layers, because either one alone leaves a gap:

1. **`@fastify/cors`** answers preflight requests and decorates responses with
   `Access-Control-Allow-Origin` (and, when configured, `-Credentials`) for
   origins the policy allows. This is the layer a browser enforces. A
   non-browser client never looks at it.
2. **An `onRequest` hook** refuses any request that carries an `Origin` the
   policy does not allow, with `403 forbidden_origin`. Without it, a disallowed
   origin would still have its request _processed_ — the browser would refuse to
   show the response, but side effects would already have happened, and a
   server-side caller can set any `Origin` it likes.

The second layer is what makes "requests from non-allowlisted origins are
rejected" true in the ordinary sense of the word. It is also the layer that
keeps a spoofable header from being treated as an access-control decision on its
own. A request with no `Origin` at all — curl, a server-side integration, a
same-origin navigation some browsers omit it from — is not a cross-origin
request and is left untouched; refusing it would break every non-browser client
to enforce a browser-only rule.

## Configuration

| Variable                 | Default | Meaning                                                                          |
| ------------------------ | ------- | -------------------------------------------------------------------------------- |
| `CORS_ALLOWED_ORIGINS`   | empty   | Comma-separated exact origins, or the single wildcard `*`.                       |
| `CORS_ALLOW_CREDENTIALS` | `false` | Send `Access-Control-Allow-Credentials` and allow cookies on cross-origin calls. |

An origin is `scheme://host[:port]` — `https://app.example.com`,
`http://localhost:5173`. It is matched **character for character** against the
browser's `Origin` header, so:

- `https://app.example.com/` (trailing slash), `https://app.example.com/path`
  and `HTTPS://APP.EXAMPLE.COM` are **rejected at startup**. They are equivalent
  to a real origin to a human and never equal to one on the wire; accepting them
  would produce a blocked front end with no error message anywhere. Rejecting
  them turns a silent misconfiguration into a boot failure.
- `http://app.example.com` and `https://app.example.com` are different origins.
  The scheme is part of the origin, and treating them as interchangeable would
  quietly allow a downgrade.
- `https://evil-app.example.com` does **not** match `https://app.example.com`.
  Nothing here does suffix or substring matching; that is the whole point.

### Empty by default

The default allowlist is empty, which denies every cross-origin browser client.
That is the right default for an API whose documented clients are server-side:
a deployment that has not considered CORS has no cross-origin front end to
break, while a deployment that has simply names its origins. The opposite
default — allow everything and tighten later — leaves every client added in the
meantime depending on the permissive policy, so tightening it becomes a
migration rather than a configuration change.

### The wildcard, and why it cannot meet credentials

`CORS_ALLOWED_ORIGINS=*` is accepted, and it means what it says: any origin may
read responses. It is legitimate for a genuinely public, unauthenticated API.

It is refused when `CORS_ALLOW_CREDENTIALS=true`. A browser will not store
credentials from a response whose `Access-Control-Allow-Origin` is `*`, so the
pairing either does nothing — looking like it works while cookies are silently
dropped — or somebody "fixes" it by reflecting the caller's origin instead,
which is the same as no same-origin policy for the cookie-bearing surface.

That refusal exists in two places on purpose. `loadConfig` rejects the
combination at startup, naming both variables. `corsPolicyFromConfig` and
`registerCors` check it again, because a `CorsPolicy` can be built directly —
by a test, or by future composition code — and the mistake is exactly the kind
someone makes by hand. Both paths throw `ConfigError` before the process binds
a port.

### Credentials are off by default, and usually should stay off

Verixa's access tokens travel in an `Authorization` header. A browser does not
attach that header to a cross-origin request on its own, so a token-
authenticated cross-origin client does not need `CORS_ALLOW_CREDENTIALS` at
all; it sets the header itself and the browser merely needs to be allowed to
read the response.

The flag is for the rarer design where a browser front end on a different origin
must carry the session cookie. Turning it on should be a deliberate statement
about that design, not a default inherited from a template — hence the `false`.

## Why the `Origin` comparison is exact

The same-origin policy is defined on origins, not on hosts, and every relaxation
of the comparison is a well-known bypass class:

- a suffix match turns `https://evil-app.example.com` into `app.example.com`;
- a prefix match turns `https://app.example.com.evil.test` into a match;
- a case-insensitive compare contradicts the browser's own serialization;
- a regex, written once to support "a subdomain or two", is a permanent source
  of holes nobody re-reads.

The rejected alternative was a `CORS_ALLOWED_ORIGIN_PATTERNS` variable with
glob support. It reads as convenience, and it is the feature every CORS incident
write-up eventually blames. If a deployment has several front ends, listing them
is a few more characters and one fewer class of mistake.

## Local development

`http://localhost:5173` (Vite and most dev servers) is a different origin from
the API, so a browser-based local front end needs an explicit allowlist entry:

```bash
CORS_ALLOWED_ORIGINS=http://localhost:5173
```

There is no development-only "allow all" back door. A back door that exists for
convenience is a back door that gets deployed, and the single-origin local case
is exactly the case where naming the origin costs nothing.

## Testing

- `apps/api/src/plugins/cors.spec.ts` — the pure decisions: validated config to
  policy, and the exact-match rule.
- `tests/integration/cors.spec.ts` — over a real socket: allowlisted origin,
  disallowed origin (including a suffix lookalike), requests with no `Origin`,
  credentialed responses, the wildcard, and preflight.
- `packages/config/index.spec.ts` — environment parsing, the wildcard-with-
  credentials refusal, and the malformed-entry rejection.

## What is deliberately not here

- **CSRF protection.** CORS stops a cross-origin page _reading_ a response; it
  does not stop it _making_ a request that changes state. That is Issue 205,
  and it is a different mechanism for a different attack.
- **Per-route CORS.** The policy is global by construction. A route that
  needed a different allowlist would be a second policy pretending to be an
  exception, and the bar for adding one is a paragraph here first.
- **Subdomain wildcards.** See above; named origins only.
- **`Access-Control-Max-Age` tuning.** The plugin sets ten minutes, which is
  long enough to save preflights on a busy front end and short enough that a
  policy change takes effect without a browser restart.
