import helmet, { type FastifyHelmetOptions } from "@fastify/helmet";
import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";

/**
 * Baseline response-header policy for every route. HSTS and the HTTPS redirect are owned by
 * `./security-headers.ts`, so helmet does not emit HSTS here.
 * docs/security/http-security-headers.md explains each value; keep it in step when a value changes.
 */
export const BASELINE_RESPONSE_HEADERS: FastifyHelmetOptions = {
  /**
   * CSP for a JSON API: `default-src 'none'`, since a JSON response is never rendered, and it is
   * easier to relax a strict policy later than to tighten a loose one. `useDefaults: false` drops
   * helmet's page-oriented defaults. The Swagger UI at `/docs` uses {@link
   * DOCS_CONTENT_SECURITY_POLICY} instead.
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
   * `no-referrer` so URLs carrying request IDs or reset tokens are never sent to third parties in
   * the `Referer` header.
   */
  referrerPolicy: { policy: "no-referrer" },

  /**
   * `Strict-Transport-Security` is owned by `./security-headers.ts`:
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
   * Turns the legacy XSS auditor off (`0`), since the auditor itself was exploitable. Helmet
   * already sends this; it is listed so the whole policy is visible here.
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
   * Cross-origin isolation headers (CORP, COOP, COEP) are deliberately not set, because they would
   * override the CORS allowlist. Revisit if the allowlist becomes single-origin.
   */
  crossOriginResourcePolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginEmbedderPolicy: false,
};

/**
 * CSP for the Swagger UI at `/docs`, the only response a browser renders as a page. It tightens
 * swagger-ui's own `staticCSP` policy to what the page actually uses:
 *
 * - `script-src 'self'` without `'unsafe-inline'`. This works because `staticCSP` makes swagger-ui
 *   serve its configuration as an external `swagger-initializer.js`.
 * - `style-src 'self'`, so no remote stylesheet can restyle the page (UI redressing).
 * - `img-src 'self' data:`, dropping `validator.swagger.io`, which would send the spec to a third
 *   party. `data:` is needed for the stylesheet's inline SVG icons.
 * - `base-uri 'none'` and `frame-ancestors 'none'`, matching the baseline.
 * - No `font-src` (it inherits `default-src 'self'`); `connect-src 'self'` covers the spec fetch.
 *
 * One inline style is blocked at first render, as it is under swagger-ui's own policy; the UI still
 * works. Fix it with a nonce or hash, never `'unsafe-inline'`.
 *
 * Applied through swagger-ui's `staticCSP` option in `app.ts`, because a root-level hook runs
 * before the docs scope's own hook and would be overwritten.
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
 * Applies {@link BASELINE_RESPONSE_HEADERS} to every response. Registered on the root instance
 * before any route; `@fastify/helmet` is `fastify-plugin`-wrapped, so every route, including
 * Fastify's 404, inherits it. The `/docs` exception is set elsewhere (see {@link
 * DOCS_CONTENT_SECURITY_POLICY}). Generic over the logger because `buildApp`'s pino `Logger` is not
 * structurally a `FastifyBaseLogger`.
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
