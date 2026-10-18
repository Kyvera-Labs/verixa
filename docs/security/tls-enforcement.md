# TLS Enforcement & HSTS

Credentials, session cookies and access tokens are bearer secrets. Whoever
holds one can use it, and a network path that can read them can use them. So
the rule this deployment posture is built around is short:

**Verixa serves over HTTPS, and a request that arrives in plaintext is either
redirected or refused.**

Roadmap Issue 213. Implementation:
`apps/api/src/plugins/security-headers.ts`, wired by `buildApp` and driven by
`@verixa/config`. Deployment guidance is below; this file is the "why" for the
defaults, because every one of them is a tradeoff somebody should be able to
disagree with knowingly.

## Where TLS terminates

Verixa does not terminate TLS. `server.ts` calls Fastify's `listen()`, which
speaks plaintext HTTP, and there is no certificate loading anywhere in the
process. This is a deliberate choice rather than an unfinished one:

- Certificate loading means a private key in the application's memory, a file
  descriptor on the key, and a reload path for renewals. All three are
  infrastructure concerns, and an application that owns them has to be
  deployed with secrets mounted into it.
- Termination at the proxy gives one place to manage certificates, one place to
  set protocol versions and cipher suites, and one place an operator can audit.
  Those are per-host decisions, not per-app decisions, and in a modular
  monolith several apps would otherwise duplicate them badly.
- Renewal automation (`certbot`, ACME in Caddy/Traefik, managed certs in a cloud
  LB) works without restarting the app.

So the **required TLS-termination point is a reverse proxy in front of the API
process**, on the same host or in front of the whole deployment. The only
supported exception is a managed load balancer that terminates TLS and forwards
in the provider's private network — which is still termination outside the app,
just not in a file you maintain.

The proxy has to do three things, all of them in one place:

1. Listen on 443 with a valid certificate; refuse to serve 80.
2. Redirect every plaintext request to HTTPS (see
   [Redirecting plaintext](#redirecting-plaintext)).
3. Set `X-Forwarded-Proto: https` on requests it forwards as HTTPS, and tell
   the app it may be believed with `TRUST_PROXY=true`.

## The header

`Strict-Transport-Security` tells a browser "having reached this origin over
TLS, refuse to speak plaintext to it again for `max-age` seconds". It converts
a class of network-position attacker (strip TLS, serve a login form over HTTP,
harvest the credentials) into a class of problem the browser solves before the
first request leaves the machine.

Verixa sends it on **every response** — successful, error, 404, and the
redirect itself — from a single `onRequest` hook registered on the root
instance:

```text
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

Why _every_ response and not just the authenticated ones: a pin is only
established by a response the browser actually looked at, and the first page a
victim reaches is often one the attacker chose. An `onRequest` hook makes
coverage a property of the transport rather than a property of each route, so a
route added next month cannot forget it. (A browser ignores the header received
over plaintext, per RFC 6797 §7.2, so sending it on an HTTP response is free.)

The values, and what turns each one off:

| Variable                  | Default    | Effect                                                               |
| ------------------------- | ---------- | -------------------------------------------------------------------- |
| `HSTS_MAX_AGE_SECONDS`    | `31536000` | `max-age`, in seconds. `0` sends `max-age=0`, which **lifts** a pin. |
| `HSTS_INCLUDE_SUBDOMAINS` | `true`     | Adds `includeSubDomains`.                                            |
| `HSTS_PRELOAD`            | `false`    | Adds `preload`; meaningful only alongside a submission.              |
| `ENFORCE_HTTPS`           | `false`    | Redirects plaintext requests to the HTTPS equivalent.                |
| `TRUST_PROXY`             | `false`    | Believes `X-Forwarded-Proto` / `X-Forwarded-For` from the proxy.     |

All five are validated by `@verixa/config`, which is the only place
`process.env` is read. `ENFORCE_HTTPS=true` with `HSTS_PRELOAD=true` and
`HSTS_INCLUDE_SUBDOMAINS=false` is a startup failure, not a silent no-op — see
[Preload](#preload).

### max-age: one year, capped at two

One year is the value that actually protects returning visitors. A pin of a few
days expires between two visits, and the window an attacker needs is exactly
the one where the victim has no pin yet.

The schema rejects anything above two years (`63072000`). This looks
counterintuitive — surely more is better? — and the reason is that the browser
**renews** the pin on every response carrying the header. `max-age` is not a
deadline that counts down from the first visit; it is "from the last time I saw
this origin securely, do not go back to plaintext for N seconds". A ten-year
value therefore does not make today safer; it makes tomorrow's migration to a
plaintext-only internal host, a temporary HTTP-served debug endpoint, or a
subdomain you forgot to provision a certificate for, unreachable from a browser
that cannot be talked out of it. The cap bounds the blast radius of a decision
that stops being reviewable once it is shipped.

`0` is worth calling out because it is the emergency exit. Omitting the header
instead would leave every existing visitor pinned until their own `max-age`
elapsed — the opposite of what someone reaching for this knob wants.

### includeSubDomains

On by default. The scope question is a DNS question: if the apex has wildcard
records, or any subdomain is delegated to something that is not this API, then
pinning the subdomains is pinning hosts you do not control.

The failure this accepts is loud and fixable: a subdomain that should have had
a certificate becomes unreachable, someone notices the same day, and it is
fixed by provisioning a certificate. The failure it avoids is quiet: a wildcard
record pointing `*.verixa.example` at a plaintext internal tool that nobody
knows about, which then becomes a hole in a posture the rest of the file claims
is closed.

If your deployment cannot say which of those two you have, set
`HSTS_INCLUDE_SUBDOMAINS=false` and turn it on once the DNS inventory is known.
That is a legitimate answer, and the knob exists so it can be taken explicitly.

### preload

Off, and there is no plan to change that default.

`preload` only does something when it is part of a submission to
[hstspreload.org](https://hstspreload.org), which puts the domain in source
bundles shipped inside Chrome, Firefox and Safari. Consequences that follow
from that:

- Removal is a request to a human being, with a multi-day wait, and until it
  completes every browser on earth refuses plaintext to the domain — including
  subdomains added after the submission.
- A preloaded domain must serve HTTPS on **every** subdomain, permanently, and
  `max-age` must be at least one year with `includeSubDomains` and `preload`.
- The commitment is not scoped to this deployment. Someone forks Verixa for an
  internal host, submits the domain, and the next person to use HTTP for a
  scratch subdomain has a problem they cannot debug.

The alternative — default it on, since it is "the strongest setting" — was
rejected because a default should be safe for the deployment that never reads
the documentation. A flag whose undo path runs through a stranger's review queue
should be one somebody types.

The one thing the code does enforce: `HSTS_PRELOAD=true` with
`HSTS_INCLUDE_SUBDOMAINS=false` throws at startup. The preload list rejects such
a directive, so that combination is a configuration that looks like a commitment
and can never be honoured. Discovering that at submission time, months later, is
worse than failing to boot.

### Why this is not `@fastify/helmet`

Helmet would set this header and eleven others in one line. It is not used here
for two reasons, and the second is the one that matters.

Helmet's `strictTransportSecurity` takes a preloaded-directive option
(`12 months`, `18 weeks`) and rounds to whole units, and its defaults differ
from the values above. A security control whose value is chosen in a config file
should be readable in that file, not after a library's mapping table.

More importantly: the other headers Helmet sets are Issue 203's deliverable
(`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, the baseline
CSP). Pulling Helmet in here would land most of another issue's work inside a
pull request about transport security, and the roadmap asks for those decisions
to be made and reviewed separately — each header maps to a different attack
class, and a bundle makes "why is this value this" unanswerable. Issue 203 may
well adopt Helmet for its own slice; nothing here precludes that, and
`security-headers.ts` is the file it names.

## Redirecting plaintext

`ENFORCE_HTTPS=true` makes the app answer a plaintext request with:

```http
HTTP/1.1 308 Permanent Redirect
Location: https://api.example.com/auth/login?tenant=acme
Strict-Transport-Security: max-age=31536000; includeSubDomains
Cache-Control: no-store
```

Four decisions in those four lines:

**308, not 301.** A 301 permits the user agent to change the follow-up request
to a GET. On `/auth/login` that discards the body — so the redirect that exists
to protect credentials would force the client to resend them blind, and a client
that does not retry the body gets a confusing empty failure. 308 is defined as
"same method, same body".

**`Cache-Control: no-store`.** The `Location` was built from the request's `Host`
header. A shared cache storing that redirect under the apex could serve another
visitor a `Location` derived from somebody else's request line. Cheap insurance
against a class of attack that requires somebody else's misconfiguration to
work.

**The `Host` is validated, not trusted.** `request.headers.host` is entirely
caller-controlled, and putting it into a response header is a header-injection
primitive. `isRedirectableHost` accepts `hostname[:port]` and `[ipv6]:port` and
nothing else — no `@`, no `/`, no whitespace, no control characters, no value
over 253 characters — and a request that fails it is answered `400` rather than
redirected. The pattern is stricter than HTTP's grammar on purpose: the goal is
not to accept every legal `Host`, it is to guarantee that nothing this function
accepts can escape the authority component of a URL.

**`X-Forwarded-Proto` is only believed with `TRUST_PROXY=true`.** Behind a
TLS-terminating proxy the app's own socket is plaintext, so without the
forwarded header the app cannot tell that the client did use HTTPS, and
`ENFORCE_HTTPS=true` produces an infinite redirect loop: proxy answers 308,
client retries over TLS, proxy forwards plaintext, app answers 308 again.
Trusting the header when no proxy is in front is its own hazard — a client can
send `X-Forwarded-Proto: https` to skip the redirect, and the same header
family (`X-Forwarded-For`) is how an IP-based blocklist gets slipped past, which
matters as soon as Issue 209 lands. Both settings are statements about network
topology, so both are opt-in and default off.

That asymmetry is why the app-level redirect defaults to off even in
production: when the proxy terminates TLS, the proxy is the component that knows
the client's scheme, and it can answer the redirect in one round trip without
involving this process. `ENFORCE_HTTPS` exists for the topology where the app
_is_ the thing reachable on port 80 — a bare VM, a single-container deploy,
`docker run -p 80:3000` — and there is no proxy to put the rule in.

### Config examples

nginx, TLS terminated here, redirect owned by the proxy:

```nginx
server {
  listen 80;
  server_name api.example.com;
  return 308 https://$host$request_uri;
}

server {
  listen 443 ssl http2;
  server_name api.example.com;

  ssl_certificate     /etc/letsencrypt/live/api.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/api.example.com/privkey.pem;
  ssl_protocols       TLSv1.2 TLSv1.3;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}
```

with `ENFORCE_HTTPS=false` (the default) and `TRUST_PROXY=true`.

Caddy does both halves without a redirect rule — `http://` redirects to
`https://` automatically and sets `X-Forwarded-Proto`:

```caddyfile
api.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

Traefik, with the redirect as middleware:

```yaml
labels:
  - "traefik.http.routers.verixa.rule=Host(`api.example.com`)"
  - "traefik.http.routers.verixa.entrypoints=websecure"
  - "traefik.http.routers.verixa.tls.certresolver=letsencrypt"
  - "traefik.http.routers.verixa-http-to-https.middlewares=verixa-redirect"
  - "traefik.http.middlewares.verixa-redirect.redirectscheme.scheme=https"
  - "traefik.http.middlewares.verixa-redirect.redirectscheme.permanent=true"
```

In every one of these the app is reached over plaintext on a private interface.
That is acceptable precisely because nothing else can reach it: bind the API to
`127.0.0.1` (or the container network) and make the port unaddressable from
outside, or the redirect at the proxy is a polite suggestion an attacker can
route around by connecting directly.

`docker-compose.yml` publishes `3000:3000` on the host. That is the development
stack, where it is convenient and deliberate — see below. A production compose
file should drop that mapping and let the proxy reach the container by name.

## Local development is plaintext, on purpose

`docker compose up` serves `http://localhost:3000`, and `pnpm dev` serves
`http://127.0.0.1:3000`. Neither has a certificate, and neither should.

This is an explicit exception with three parts, not a gap that nobody has
noticed:

1. **`securityHeadersFromConfig` returns `hsts: null` unless
   `NODE_ENV=production`.** Not a stylistic choice: pinning `localhost` is a
   way to lose an afternoon. A developer who probes the HTTPS listener once with
   a self-signed certificate gets a browser that refuses plaintext to that
   origin for the whole `max-age`, and the only exit is the browser's own
   HSTS-removal UI (or, once preloaded, an OS-level reset). The environment
   decides, so nobody has to remember.
2. **`ENFORCE_HTTPS` still works in development.** Unlike the pin it stores
   nothing in the browser, so testing the redirect locally is safe and
   immediately reversible. That asymmetry is exactly why one is gated by
   `NODE_ENV` and the other is not.
3. **Cookies carry `Secure`, and this package never relaxes it.** A browser will
   not store a `Secure` cookie for an origin it does not treat as trustworthy,
   so local development goes through `http://localhost` or `http://127.0.0.1`
   (which current Chrome and Firefox accept as trustworthy origins for cookies)
   rather than a LAN IP or a machine name. If a deployment needs the LAN-IP
   case, the answer is a locally trusted certificate (`mkcert`), not
   `Secure: false`. See
   [Secure cookie configuration](./secure-cookies.md) for why the flag is not
   configurable per environment.

Testing HSTS behaviour locally therefore means testing the _header_, not the
browser's reaction to it: the integration suite
(`tests/integration/security-headers.spec.ts`) asserts the exact field value,
the 308, the `no-store`, and the forwarded-proto handling, all over a plaintext
socket.

## What is deliberately not here

- **Certificate lifecycle, TLS version and cipher policy.** They belong to the
  terminating proxy, and are its to configure and audit.
- **HTTP Public Key Pinning.** Removed from the Web Platform and from browsers;
  do not look for it here.
- **Mixed-content policy for served HTML.** Issue 212 (CSP for documentation and
  admin surfaces), which will extend this file's plugin.
- **`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, CSP.**
  Issue 203. Each mitigates a different attack class and gets reviewed on its
  own terms.
- **CORS and CSRF.** Issues 204 and 205. TLS protects the wire, not the
  browser's same-origin policy.

## Checklist for a deployment

- [ ] 443 serves the API with a valid certificate; nothing on 80 except the
      redirect.
- [ ] The API process is reachable only from the proxy (bind address, security
      group, or an unpublished container port).
- [ ] The proxy sets `X-Forwarded-Proto` and the app runs with
      `TRUST_PROXY=true`.
- [ ] `curl -i http://<host>/health` returns a redirect, not a `200` with a
      body.
- [ ] `curl -i https://<host>/health` returns
      `strict-transport-security: max-age=31536000; includeSubDomains`.
- [ ] [`nmap`/`testssl.sh`/Mozilla's TLS scanner](https://observatory.mozilla.org)
      reports no plaintext listener and a valid HSTS policy.
- [ ] `HSTS_PRELOAD` is `false` unless somebody has read
      [the submission's consequences](#preload) and signed off on them.
- [ ] Any subdomain that must stay reachable over HTTP is accounted for before
      `HSTS_INCLUDE_SUBDOMAINS` is left on.
