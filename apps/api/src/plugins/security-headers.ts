import { ConfigError, type Config } from "@verixa/config";
import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";

/**
 * `Strict-Transport-Security` and the HTTP-to-HTTPS redirect: the transport-security headers.
 * Content headers live in `./baseline-response-headers.ts`.
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
 * Policy used when `buildApp` is given none: both features off. Safe because `server.ts` always
 * passes `securityHeadersFromConfig(loadConfig())`; the default only serves in-process tests that
 * never bind a port.
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
 * Turns validated config into a transport-security policy.
 *
 * 1. HSTS is off outside production, because a browser that pins `localhost` keeps refusing
 *    plaintext for the whole `max-age`.
 * 2. `preload` requires `includeSubDomains`, since the preload list rejects entries without it.
 *    That combination throws at startup instead of emitting a directive that cannot work.
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
 * Whether a `Host` value is `hostname[:port]` or `[ipv6]:port`. Checked by splitting on `.` and
 * `:`, which is linear on client-controlled input, where a single regex would risk catastrophic
 * backtracking. Accepts `example.com`, `localhost:3000` and `[::1]:3000`; rejects
 * `example.com@evil`, `example.com/evil`, leading or trailing hyphens, a trailing dot, a bare port
 * and extra colons.
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
 * Registers the transport-security controls as an `onRequest` hook in `buildApp`'s own context,
 * because a registered plugin would only cover routes inside its encapsulation scope. Generic over
 * the logger because `buildApp`'s pino `Logger` is not structurally a `FastifyBaseLogger`.
 *
 * Both controls apply to every response, including errors and the redirect:
 *
 * - HSTS is sent even over HTTP, where browsers ignore it (RFC 6797 §7.2), so coverage does not
 *   depend on the transport.
 * - The 308 redirect is `no-store`, so a shared cache never stores a `Location` built from another
 *   client's `Host` header.
 */
export function registerSecurityHeaders<TLogger extends FastifyBaseLogger>(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression,
    RawReplyDefaultExpression,
    TLogger
  >,
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
