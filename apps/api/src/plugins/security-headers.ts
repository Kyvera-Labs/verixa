import helmet, { type FastifyHelmetOptions } from "@fastify/helmet";
import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";

/**
 * The response-header policy every route serves under.
 *
 * Each value mitigates a named attack class. The table in
 * `docs/security/http-security-headers.md` is the reference; the notes here are
 * the reminders. Keep the two in step when a value changes — a header whose
 * value nobody can explain is a header someone deletes to "fix" a browser
 * problem.
 */
export const SECURITY_HEADERS: FastifyHelmetOptions = {
  /**
   * Baseline CSP for a JSON-over-HTTP API.
   *
   * `default-src 'none'` allows no subresource of any kind. That is only safe
   * because every route here answers `application/json` — a document a browser
   * fetches but never *renders* as a page, so there is nothing for the policy to
   * break. It is also the cheapest position to start from: relaxing a CSP is a
   * decision you make later with a specific need in front of you, while
   * tightening one shipped at `unsafe-inline` is a migration across every client
   * that came to depend on it.
   *
   * `useDefaults: false` drops helmet's own baseline, which allows
   * `script-src 'self'` and `style-src 'unsafe-inline'` on behalf of
   * server-rendered pages this API does not have.
   *
   * The first HTML surface (Swagger UI in Issue 237, the verification review UI)
   * will need this relaxed, and Issue 212 owns that change — with a per-request
   * nonce rather than `unsafe-inline`, which is the difference between a CSP
   * that stops injected script and one that only looks strict.
   */
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'none'"],
      // A `<base>` tag could repoint relative URLs at an attacker's host, and
      // `default-src` does not cover it.
      baseUri: ["'none'"],
      // Nothing here renders a form that may be submitted anywhere.
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
   * TLS stripping: once a browser has seen this header it upgrades every later
   * request to HTTPS without consulting the network, so a hostile access point
   * cannot downgrade the connection and read the session cookie or bearer token
   * in cleartext.
   *
   * One year, `includeSubDomains` on, and **no `preload`** — preload is a
   * submission to a browser-shipped list that is awkward to reverse and breaks
   * every plaintext subdomain, including provisioning hosts. That decision, and
   * the TLS-termination topology it depends on, belongs to Issue 213.
   *
   * The header goes out over plaintext local HTTP too. That is harmless rather
   * than wrong: browsers ignore HSTS for a non-secure origin, so local
   * development is unaffected, and gating it on `request.protocol` would make
   * the policy depend on proxy headers a misconfigured deployment can lie about.
   */
  hsts: {
    maxAge: 31_536_000,
    includeSubDomains: true,
  },

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
   * into leaking data and it weakened CSP enforcement. `0` is the modern value,
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
 * Applies {@link SECURITY_HEADERS} to every response this instance produces.
 *
 * Registered on the root instance in `buildApp`, before any route:
 * `@fastify/helmet` is `fastify-plugin`-wrapped, so its hook is inherited by
 * child scopes rather than confined to a prefix, and every route — including
 * ones later phases add — gets the headers without opting in. Safe by default
 * only holds if the default is applied at the root: a plugin someone has to
 * remember to register is a plugin someone will forget.
 *
 * Generic over the logger for the same reason `registerAuthRoutes` is (see
 * `routes/auth.ts`) — the instance `buildApp` produces carries a concrete pino
 * `Logger`, which is not structurally identical to Fastify's
 * `FastifyBaseLogger`.
 */
export function registerSecurityHeaders<TLogger extends FastifyBaseLogger = FastifyBaseLogger>(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression,
    RawReplyDefaultExpression,
    TLogger
  >,
): void {
  app.register(helmet, SECURITY_HEADERS);
}
