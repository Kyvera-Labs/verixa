import helmet, { type FastifyHelmetOptions } from "@fastify/helmet";
import { ConfigError, type Config } from "@verixa/config";
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
 * The `Strict-Transport-Security` directive and the HTTP-to-HTTPS redirect
 * (roadmap Issue 213).
 *
 * This module owns the *transport-security* slice of the response headers
 * only. `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` and the
 * baseline CSP belong to Issue 203 and will be added here (or beside it) when
 * that issue lands — deliberately not folded in now, so this change stays
 * reviewable as one threat class: credentials and tokens moving in cleartext.
 */

/** The header name, lower-cased the way Node stores received headers. */
export const HSTS_HEADER_NAME = "strict-transport-security";

/**
 * One year. The floor a browser needs to make pinning worthwhile: a shorter
 * window than the average gap between deploys pins nothing for most visitors.
 */
export const DEFAULT_HSTS_MAX_AGE_SECONDS = 31_536_000;

/**
 * Two years, the `max-age` HSTS preload requires — and, more importantly, the
 * practical ceiling. A larger value is not "more secure": the browser renews
 * the pin on every visit that carries the header, so a `max-age` of a decade
 * means a misconfigured deployment keeps forcing HTTPS on returning visitors
 * for ten years after they last saw it.
 */
export const MAX_HSTS_MAX_AGE_SECONDS = 63_072_000;

export interface HstsDirective {
  readonly maxAgeSeconds: number;
  readonly includeSubDomains: boolean;
  readonly preload: boolean;
}

export interface SecurityHeadersOptions {
  /**
   * `null` means the header is not sent at all — the state a local development
   * server runs in. See `docs/security/tls-enforcement.md` for why that is an
   * explicit exception rather than a gap.
   */
  readonly hsts: HstsDirective | null;
  /**
   * Redirect plaintext requests to the HTTPS equivalent. Only meaningful when
   * the process can actually tell an HTTPS request from a plaintext one, which
   * needs either the TLS handshake terminating here or `trustProxy` enabled —
   * see `registerSecurityHeaders`.
   */
  readonly enforceHttps: boolean;
}

/**
 * The shape `buildApp` uses when the caller supplies no policy at all.
 *
 * Both features off. That sounds like the wrong default for a security
 * control, and it is only safe because of who the caller is: `server.ts`
 * always passes `securityHeadersFromConfig(loadConfig())`, so a process that
 * actually serves traffic always has a policy derived from a validated
 * environment. The bare default exists for in-process tests and for
 * `buildApp()` calls that never bind a port, where an HSTS pin or a redirect
 * would be noise at best and a hang at worst.
 */
export const NO_TRANSPORT_SECURITY: SecurityHeadersOptions = {
  hsts: null,
  enforceHttps: false,
};

/**
 * The `Strict-Transport-Security` field value for a directive.
 *
 * `max-age` first and unquoted, then the optional flags — the order RFC 6797
 * §6.1.1 examples use, and the order a UA that fails to parse the field is
 * most likely to still read `max-age` from.
 */
export function formatHstsHeader(directive: HstsDirective): string {
  // The value is bound for a browser's security state, so it is checked here
  // as well as in the environment schema: `HstsDirective` is constructed
  // directly by callers that never went through `loadConfig` (tests first among
  // them), and a directive that says `max-age=-1`, `max-age=1e99`, or a
  // fraction is a directive whose meaning no two UAs agree on.
  if (
    !Number.isInteger(directive.maxAgeSeconds) ||
    directive.maxAgeSeconds < 0 ||
    directive.maxAgeSeconds > MAX_HSTS_MAX_AGE_SECONDS
  ) {
    throw new RangeError(
      `Invalid HSTS max-age ${directive.maxAgeSeconds}: must be a whole number of seconds ` +
        `between 0 and ${MAX_HSTS_MAX_AGE_SECONDS} (two years).`,
    );
  }

  const parts = [`max-age=${directive.maxAgeSeconds}`];

  if (directive.includeSubDomains) {
    parts.push("includeSubDomains");
  }

  if (directive.preload) {
    parts.push("preload");
  }

  return parts.join("; ");
}

/**
 * The slice of validated configuration this module needs, named rather than
 * duplicated: `Pick` means a new transport-security variable has to be added
 * to the schema in `@verixa/config` and to this list in the same change, and
 * the type checker catches the second half being forgotten.
 */
export type TransportSecurityConfig = Pick<
  Config,
  "NODE_ENV" | "HSTS_MAX_AGE_SECONDS" | "HSTS_INCLUDE_SUBDOMAINS" | "HSTS_PRELOAD" | "ENFORCE_HTTPS"
>;

/**
 * Turn validated config into a policy.
 *
 * Two rules do the interesting work:
 *
 * 1. **HSTS is off outside production.** A pinned `localhost` is a real
 *    hazard: a developer who tests the HTTPS listener once with a self-signed
 *    certificate gets a browser-enforced "never speak plaintext to this
 *    origin" promise for the whole `max-age`, and the only way out is the
 *    browser's own HSTS-removal UI (or, once preloaded, an OS-level reset).
 *    The header costs nothing in production and can cost an afternoon in
 *    development, so the environment decides.
 * 2. **`preload` requires `includeSubDomains`.** The preload list rejects a
 *    submission whose field omits it, so a configuration that sets the flag
 *    without the subdomain scope is one that silently never takes effect.
 *    Rather than emit a directive that cannot work, this throws at startup —
 *    same fail-fast posture as `loadConfig` itself.
 */
export function securityHeadersFromConfig(config: TransportSecurityConfig): SecurityHeadersOptions {
  if (config.NODE_ENV !== "production") {
    return { hsts: null, enforceHttps: config.ENFORCE_HTTPS };
  }

  if (config.HSTS_PRELOAD && !config.HSTS_INCLUDE_SUBDOMAINS) {
    throw new ConfigError(
      "Invalid transport-security configuration: HSTS_PRELOAD requires " +
        "HSTS_INCLUDE_SUBDOMAINS. The preload list refuses a " +
        "Strict-Transport-Security field that omits includeSubDomains, so this " +
        "combination can never do what it looks like it does. Set " +
        "HSTS_INCLUDE_SUBDOMAINS=true, or HSTS_PRELOAD=false.",
    );
  }

  return {
    hsts: {
      maxAgeSeconds: config.HSTS_MAX_AGE_SECONDS,
      includeSubDomains: config.HSTS_INCLUDE_SUBDOMAINS,
      preload: config.HSTS_PRELOAD,
    },
    enforceHttps: config.ENFORCE_HTTPS,
  };
}

/**
 * A `Host` header this process is willing to put in a `Location`.
 *
 * A redirect built straight from `request.headers.host` is a header-injection
 * primitive: whatever the client claims to have addressed becomes part of the
 * response, and a value containing a newline would be response splitting.
 * Browsers send a plain hostname, so the allow-list costs nothing in practice
 * — but it has to cover IPv6 literals (`[::1]`, brackets included) and a port.
 */

/**
 * Rejects anything outside printable ASCII before any shape rule runs.
 *
 * A control character in a `Host` is the response-splitting attempt. Node's
 * HTTP serializer would refuse to write one into a header anyway, but a guard
 * that lives in the layer *after* the value is used is a guard nobody reading
 * this file can see, and JavaScript's `$` matches immediately before a trailing
 * newline — so an anchored shape pattern alone would let `evil.com\n` through.
 */
const PRINTABLE_ONLY = /^[\x21-\x7e]+$/;

/** Alphanumerics and hyphens; the start/end rules are checked separately. */
const LABEL_CHARS = /^[A-Za-z0-9-]+$/;

/** `[:digits]` — 1 to 5 of them, since 65535 is the largest valid port. */
const PORT = /^\d{1,5}$/;

/** The bracketed address itself, port not included. */
const IPV6_ADDRESS = /^\[[0-9A-Fa-f:]+\]$/;

/** One DNS label: alphanumerics and hyphens, not starting or ending with a hyphen. */
function isHostnameLabel(label: string): boolean {
  return (
    label.length > 0 && !label.startsWith("-") && !label.endsWith("-") && LABEL_CHARS.test(label)
  );
}

/** `[ipv6]` or `[ipv6]:port`. Bracketed, so no port-splitting is involved. */
function isIpv6Literal(authority: string): boolean {
  const closing = authority.indexOf("]");

  if (closing === -1) {
    return false;
  }

  const rest = authority.slice(closing + 1);

  return (
    IPV6_ADDRESS.test(authority.slice(0, closing + 1)) &&
    (rest === "" || (rest.startsWith(":") && PORT.test(rest.slice(1))))
  );
}

/**
 * `hostname[:port]` or `[ipv6]:port`, nothing else.
 *
 * Checked by splitting on `.` and `:` rather than with one pattern, and that is
 * not a style preference. The single-regex form needs a quantified group that
 * can match a hyphen run, which is either exponential on a hostile value or
 * flagged as unsafe by the linter, and this function runs on a header the client
 * picks. Splitting is linear and reads as rules: labels, then an optional port.
 *
 * So `example.com`, `upstream-42.example.com`, `localhost:3000` and
 * `[::1]:3000` pass, while `example.com@evil`, `example.com/evil`,
 * `-example.com`, `example.com-`, a trailing dot, `:3000` and any second colon
 * outside brackets all fail.
 */
function isRedirectableAuthority(host: string): boolean {
  if (host.startsWith("[")) {
    return isIpv6Literal(host);
  }

  const separator = host.lastIndexOf(":");
  const name = separator === -1 ? host : host.slice(0, separator);
  const port = separator === -1 ? "" : host.slice(separator + 1);

  if (separator !== -1 && !PORT.test(port)) {
    return false;
  }

  // `split` on a name with an empty label ("", ".example.com", "example..com")
  // hands back an empty string, which `isHostnameLabel` refuses — so the
  // length check below is only about the no-labels-at-all case.
  return name.length > 0 && name.split(".").every(isHostnameLabel);
}

export function isRedirectableHost(host: string | undefined): host is string {
  if (host === undefined) {
    return false;
  }

  // Rejected outright rather than left to the shape rules: 253 characters is
  // the longest a legal hostname may be, and an over-long value is already a
  // malformed request no browser sent.
  if (host.length === 0 || host.length > 253) {
    return false;
  }

  return PRINTABLE_ONLY.test(host) && isRedirectableAuthority(host);
}

/**
 * The HTTPS counterpart of a plaintext request URL.
 *
 * `undefined` means "do not redirect this request" — either the `Host` is not
 * something worth putting in a `Location`, or there is no authority to build
 * an absolute target from. Returning `undefined` instead of throwing keeps the
 * hook's failure mode a plain 400 rather than a 500, and keeps this function
 * pure enough to test without an HTTP request at all.
 */
export function httpsRedirectTarget(host: string | undefined, rawUrl: string): string | undefined {
  if (!isRedirectableHost(host)) {
    return undefined;
  }

  // Fastify's `request.raw.url` is the origin-form target (`/path?query`),
  // always starting with `/`; a request line that does not is not something
  // this process should be turning into an absolute URL.
  if (!rawUrl.startsWith("/") || rawUrl.startsWith("//")) {
    return undefined;
  }

  return `https://${host}${rawUrl}`;
}

/**
 * Register the transport-security controls on `app`.
 *
 * Generic over the logger type for the same reason `registerAuthRoutes` is:
 * the instance `buildApp` produces carries a concrete pino `Logger`, which
 * Fastify's default `FastifyBaseLogger` generic is not structurally
 * compatible with, and pinning the default here would reject that very
 * instance.
 *
 * An `onRequest` hook, not a plugin: Fastify encapsulates hooks inside a
 * registered plugin to the routes registered in that same context, so a
 * `register()`-style wiring would silently skip every route added afterwards
 * on the parent instance. `buildApp` adds the routes, so `buildApp` adds the
 * hook, in the same encapsulation context.
 *
 * Both controls are unconditional per response, including on errors and on
 * the redirect itself:
 *
 * - A browser ignores `Strict-Transport-Security` received over plaintext
 *   (RFC 6797 §7.2), so sending it on an HTTP response costs a header and
 *   pins nobody. Sending it *only* on HTTPS responses would work too, but it
 *   makes "is this route covered?" a question about the transport rather than
 *   about the code, and that is the kind of thing that quietly regresses.
 * - The redirect must not be cacheable. `no-store` on the 308 keeps a shared
 *   cache from storing a `Location` derived from a `Host` header some other
 *   client sent.
 */
export function registerSecurityHeaders<TLogger extends FastifyBaseLogger>(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression,
    RawReplyDefaultExpression,
    TLogger
  >,
): void {
  app.register(helmet, SECURITY_HEADERS);
  options: SecurityHeadersOptions,
): void {
  const hstsHeaderValue = options.hsts === null ? null : formatHstsHeader(options.hsts);

  app.addHook("onRequest", async (request, reply) => {
    if (hstsHeaderValue !== null) {
      reply.header(HSTS_HEADER_NAME, hstsHeaderValue);
    }

    if (!options.enforceHttps || request.protocol === "https") {
      return;
    }

    const target = httpsRedirectTarget(request.headers.host, request.raw.url ?? "");

    if (target === undefined) {
      // Not a request this process can safely redirect. Answering 400 beats
      // serving it over plaintext: the caller's alternative is cleartext.
      await reply.status(400).type("application/json").send({
        error: "bad_request",
        message: "Request Host is not usable to build an HTTPS redirect target.",
      });
      return;
    }

    // 308 rather than 301: 301 historically lets a UA switch a POST to a GET,
    // which silently drops the body of exactly the requests that matter here
    // (`/auth/login`, `/auth/register`). 308 is defined as "same method, same
    // body, retry" — the only redirect that survives a credential POST.
    await reply.status(308).header("location", target).header("cache-control", "no-store").send();
  });
}
