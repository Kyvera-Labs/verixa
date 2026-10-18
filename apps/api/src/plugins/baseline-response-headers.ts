import helmet, { type FastifyHelmetOptions } from "@fastify/helmet";
import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";

/**
 * The baseline response-header policy every route serves under (Issue 203).
 *
 * This is the *content* half of the header story. The *transport* half —
 * `Strict-Transport-Security` and the plaintext-to-HTTPS redirect — is a
 * separate, config-driven module in `./security-headers.ts` (Issue 213), because
 * it depends on where TLS terminates and has a different failure mode. The two
 * compose: helmet is told not to emit an HSTS pin here so that module owns the
 * header outright.
 *
 * Each value mitigates a named attack class. The table in
 * `docs/security/http-security-headers.md` is the reference; the notes here are
 * the reminders. Keep the two in step when a value changes — a header whose
 * value nobody can explain is a header someone deletes to "fix" a browser
 * problem.
 */
export const BASELINE_RESPONSE_HEADERS: FastifyHelmetOptions = {
  /**
   * Baseline CSP for a JSON-over-HTTP API.
   *
   * `default-src 'none'` allows no subresource of any kind. That is safe because
   * a JSON response is a document a browser fetches but never *renders*, so
   * there is nothing for the policy to break — and it is the cheapest position
   * to start from: relaxing a CSP is a decision made later with a specific need
   * in front of you, while tightening one that shipped at `unsafe-inline` is a
   * migration across every client that came to depend on it.
   *
   * The one exception is the Swagger UI at `/docs`, which really is an HTML page.
   * It gets {@link DOCS_CONTENT_SECURITY_POLICY}, applied through that plugin's
   * own `staticCSP` option where it is registered rather than by weakening this
   * policy for everything else.
   *
   * `useDefaults: false` drops helmet's own baseline, which allows
   * `script-src 'self'` and `style-src 'unsafe-inline'` on behalf of
   * server-rendered pages this API does not have.
   */
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'none'"],
      // A `<base>` tag could repoint relative URLs at an attacker's host, and
      // `default-src` does not cover it.
      baseUri: ["'none'"],
      // Nothing a JSON response can render may submit a form anywhere.
      formAction: ["'none'"],
      // Mirrored by X-Frame-Options below: CSP is the modern mechanism, the
      // header is the fallback for clients that predate it.
      frameAncestors: ["'none'"],
    },
  },

  /**
   * Clickjacking: a hostile page frames `POST /auth/login` under a transparent
   * overlay and the victim's own click lands on it. Framing is refused outright
   * rather than allowlisted, because no supported deployment embeds these
   * responses in a frame today — an allowlist with no members is the same
   * policy with more ways to get it wrong.
   */
  frameguard: { action: "deny" },

  /**
   * MIME sniffing: a browser is served `text/plain` containing `<script>` and
   * decides it is HTML. `nosniff` makes the declared `Content-Type` binding,
   * which turns an upload-as-XSS vector into an inert download.
   */
  noSniff: true,

  /**
   * Referrer leakage: a URL carrying a verification request id or a reset token
   * is handed to every third party the page then loads, through the `Referer`
   * header. `no-referrer` sends none at all.
   *
   * The weaker, more common `strict-origin-when-cross-origin` leaks the full
   * path on same-origin navigations and the origin cross-origin — reasonable for
   * a site that wants analytics, pointless for an API whose requests should not
   * be attributable anywhere.
   */
  referrerPolicy: { policy: "no-referrer" },

  /**
   * `Strict-Transport-Security` is owned by `./security-headers.ts` (Issue 213):
   * its `max-age`, scope and `preload` flag come from validated configuration,
   * and it is sent by an `onRequest` hook that also performs the HTTPS redirect.
   * Emitting a second pin from here would make the header's value depend on hook
   * ordering, which is not a property anyone reviewing a TLS decision can check.
   */
  hsts: false,

  /**
   * `X-Powered-By` is a fingerprint: it names the stack before an attacker has
   * probed it. Fastify sends nothing by default, and proxies and middleware
   * re-add it, so removing it stays worth doing.
   */
  hidePoweredBy: true,

  /**
   * Legacy Flash integration: `crossdomain.xml` lets a policy-aware client read
   * this origin from any other. `none` refuses the mechanism entirely. Listed
   * explicitly so this object is the whole policy rather than helmet's defaults
   * plus a few edits.
   */
  permittedCrossDomainPolicies: { permittedPolicies: "none" },

  /**
   * The legacy XSS auditor, switched off.
   *
   * IE and old Chrome re-wrote pages to highlight matched strings in order to
   * "protect" users, which was itself exploitable — the filter could be provoked
   * into leaking data, and it weakened CSP enforcement. `0` is the modern value,
   * and helmet already sends it. Listed here rather than left implicit because
   * this object is meant to be the whole policy: a header that arrives only
   * because a dependency defaults it is a header a reviewer cannot find.
   */
  xXssProtection: true,

  /**
   * Browser DNS pre-resolution of linked hosts leaks lookups to internal
   * hostnames and buys a JSON API nothing.
   */
  dnsPrefetchControl: { allow: false },

  /**
   * IE could execute a downloaded response in the originating site's context.
   */
  ieNoOpen: true,

  /**
   * Clustered origins let a same-process window bypass origin checks.
   */
  originAgentCluster: true,

  /**
   * Cross-origin isolation headers are **not** set here, and that is a
   * deliberate exclusion rather than an oversight.
   *
   * `Cross-Origin-Resource-Policy`, `Cross-Origin-Opener-Policy` and
   * `Cross-Origin-Embedder-Policy` decide which *other origins* may read or
   * relate to these responses — exactly the question Issue 204 (CORS) answers
   * with an environment-specific allowlist. Setting a blanket `same-origin` here
   * would pre-empt it, and the failure mode is a confusingly blocked front end
   * rather than a blocked attack.
   *
   * Revisit when 204 lands: if the allowlist ends up single-origin, these are
   * worth enabling alongside it.
   */
  crossOriginResourcePolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginEmbedderPolicy: false,
};

/**
 * The policy for the documentation UI — the one response this API produces that
 * a browser renders as a document, and therefore the one place
 * {@link BASELINE_RESPONSE_HEADERS}'s `default-src 'none'` cannot be used: under
 * it `/docs` is a blank page, because the UI is an HTML document that loads its
 * own bundle and stylesheet and fetches `/docs/openapi.json` to draw the spec.
 *
 * `@fastify/swagger-ui` ships a policy for this (`staticCSP: true`) and this
 * replaces it, directive by directive, with something tighter. Every value here
 * is what the served page actually uses: its `index.html` loads three external
 * `<script src>` tags with no inline script and no `style` attribute, and its
 * stylesheet embeds icons as `url("data:image/svg+xml…")`:
 *
 * - `script-src 'self'` with no `'unsafe-inline'`. That holds only because the
 *   UI is registered with `staticCSP`, which is what makes swagger-ui serve its
 *   configuration as an external `swagger-initializer.js` instead of an inline
 *   `<script>` block. Drop that option and this policy breaks the page — which
 *   is the trade being made deliberately: an external file we control is one
 *   less way for a payload in the spec to become code.
 * - `style-src 'self'`, where swagger-ui's own default also allows `https:`.
 *   A remote stylesheet is UI redressing: enough to move a "Try it out" button
 *   under the cursor of whoever is about to execute a request against a live
 *   environment. Nothing here needs one — the CSS is served from `/docs/static`
 *   and sets no webfont.
 * - `img-src 'self' data:`, dropping swagger-ui's `validator.swagger.io`. That
 *   origin is a validator the page can be pointed at, and loading an image from
 *   it sends this deployment's spec to a third party. `data:` stays because the
 *   bundle's icons are inlined as SVG data URIs in its stylesheet, and CSP checks
 *   a stylesheet's `url()` fetches against `img-src` — so they are this
 *   directive's to allow or not.
 * - `base-uri 'none'` and `frame-ancestors 'none'`, against swagger-ui's
 *   `'self'` for both, matching the baseline: no `<base>` tag and no frame
 *   appear anywhere in the served page, so nothing is lost.
 * - `font-src` omitted, so it inherits `default-src 'self'`. The stylesheet uses
 *   `font-family: sans-serif` and loads no `@font-face`, so a directive for it
 *   would be one more value nobody can point at a reason for.
 * - `connect-src 'self'` covers the spec fetch, and no directive here permits an
 *   `http:` origin, which is why swagger-ui's `upgrade-insecure-requests` is
 *   gone: it can only rewrite a request this policy already forbids.
 *
 * Loading `/docs` in a real browser under this policy reports exactly one
 * violation: the bundle applies one inline style at first render, and CSP blocks
 * it. The page still fetches the spec, expands every operation, and opens the
 * Authorize modal — and the same violation, with the same `sha256` hash, appears
 * under swagger-ui's own `staticCSP: true`, which also has no `'unsafe-inline'`.
 * So `'unsafe-inline'` is not what makes this UI work and adding it would only
 * widen the policy: a stylesheet written in markup can restyle the page, which
 * is the same UI-redressing argument as the remote one above. If that one
 * blocked style ever becomes a broken control, the fix is a nonce or a hash for
 * the specific declaration, and Issue 212 is where nonce plumbing belongs.
 *
 * Applied as `@fastify/swagger-ui`'s `staticCSP` option in `app.ts` rather than
 * as a hook here, because the plugin sets its own policy from an `onSend` hook
 * registered inside the scope that owns the docs routes. A root-level hook runs
 * before a scope's own hooks, so an override written here is overwritten for
 * `/docs` itself and applies only to routes registered at the root — a hook that
 * looks like it works, does nothing, and fails silently. `staticCSP` is the
 * supported knob and the value lands on every docs response.
 */
export const DOCS_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "script-src-attr 'none'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Applies {@link BASELINE_RESPONSE_HEADERS} to every response this instance
 * produces.
 *
 * Registered on the root instance in `buildApp`, before any route:
 * `@fastify/helmet` is `fastify-plugin`-wrapped, so its hook is inherited by
 * child scopes rather than confined to a prefix, and every route — including
 * ones later phases add, and Fastify's own 404 — gets the headers without
 * opting in. Safe by default only holds if the default is applied at the root:
 * a plugin someone has to remember to register is a plugin someone will forget.
 *
 * The `/docs` exception is *not* applied here; see
 * {@link DOCS_CONTENT_SECURITY_POLICY} for why a hook written at this level
 * cannot set it.
 *
 * Generic over the logger for the same reason `registerSecurityHeaders` is (see
 * `./security-headers.ts`) — the instance `buildApp` produces carries a concrete
 * pino `Logger`, which is not structurally identical to Fastify's
 * `FastifyBaseLogger`.
 */
export function registerBaselineResponseHeaders<
  TLogger extends FastifyBaseLogger = FastifyBaseLogger,
>(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression,
    RawReplyDefaultExpression,
    TLogger
  >,
): void {
  app.register(helmet, BASELINE_RESPONSE_HEADERS);
}
