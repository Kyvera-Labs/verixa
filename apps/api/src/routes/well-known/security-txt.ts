import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";

/**
 * `/.well-known/security.txt` (Issue 211, RFC 9116).
 *
 * A machine-readable pointer to the disclosure policy, at the path an
 * automated scanner or a security researcher tries first. The prose lives in
 * `SECURITY.md` at the repository root; this route exists so that a tool
 * asking "does this project have a channel?" gets an answer rather than a 404.
 */

/** Where a report actually goes. Private security advisories; see `SECURITY.md`. */
const CONTACT_URL = "https://github.com/Kyvera-Labs/verixa/security/advisories/new";

/** The human-readable policy this document points at. */
const POLICY_URL = "https://github.com/Kyvera-Labs/verixa/blob/master/SECURITY.md";

/**
 * Whether a `Host` value is a hostname with an optional port. `Canonical` is built from this
 * header, so anything else is dropped rather than rendered, preventing injected lines. Bounds
 * follow RFC 1035 (253 characters, 5-digit port); host and port are checked separately so neither
 * check can backtrack.
 */
const HOST_NAME = /^[A-Za-z0-9._-]{1,253}$/;
const PORT_NUMBER = /^[0-9]{1,5}$/;

function isWellFormedHost(value: string): boolean {
  const separator = value.indexOf(":");

  if (separator === -1) return HOST_NAME.test(value);

  // A second colon means either a repeated port or a bare IPv6 literal, and
  // neither is worth reasoning about: RFC 9116 readers only need a host they
  // can trust, and this server has no reason to advertise an IPv6 address.
  if (separator !== value.lastIndexOf(":")) return false;

  return HOST_NAME.test(value.slice(0, separator)) && PORT_NUMBER.test(value.slice(separator + 1));
}

/**
 * When the contact information in this document was last confirmed current.
 *
 * RFC 9116 requires the timestamp in `YYYY-MM-DDThh:mm:ssZ` form: no
 * fractional seconds, and a literal `Z` rather than `+00:00`. `toISOString()`
 * produces both of the disallowed forms, so it is trimmed here.
 */
function rfc9116Timestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * The next 1 January at least `MINIMUM_HORIZON_DAYS` away, so `Expires` is always in the future yet
 * still a real date by which someone should re-check this file.
 */
const MINIMUM_HORIZON_DAYS = 60;

export function securityTxtExpiresAt(now: Date = new Date()): Date {
  const horizon = now.getTime() + MINIMUM_HORIZON_DAYS * 24 * 60 * 60 * 1000;

  let year = now.getUTCFullYear() + 1;
  let candidate = Date.UTC(year, 0, 1);
  // Reached in November and December, when the coming New Year is inside the
  // horizon: the *next* one is still far enough out to be a real deadline.
  while (candidate < horizon) {
    year += 1;
    candidate = Date.UTC(year, 0, 1);
  }

  return new Date(candidate);
}

/**
 * The response body, as a pure function of the request's host and the clock.
 *
 * Split from the handler so the formatting rules — field names, the timestamp
 * shape, the order — are checkable without an HTTP server.
 */
export function buildSecurityTxt(host: string | undefined, now: Date = new Date()): string {
  const lines = [
    `Contact: ${CONTACT_URL}`,
    `Expires: ${rfc9116Timestamp(securityTxtExpiresAt(now))}`,
    "Preferred-Languages: en",
    `Policy: ${POLICY_URL}`,
  ];

  // Optional by RFC 9116, and omitted rather than guessed at: a canonical URL
  // built from an absent or malformed host header is a fabrication, and this
  // document's whole value is that it can be trusted.
  if (host !== undefined && isWellFormedHost(host)) {
    lines.push(`Canonical: https://${host}/.well-known/security.txt`);
  }

  // Trailing newline: RFC 9116 expects the last line to be terminated, and a
  // file saved from this response should parse as a complete record.
  return `${lines.join("\n")}\n`;
}

/**
 * Registers the route. Needs no container, so the disclosure contact is reachable even when the
 * database is down.
 */
export function registerSecurityTxtRoute<TLogger extends FastifyBaseLogger>(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression,
    RawReplyDefaultExpression,
    TLogger
  >,
): void {
  app.get("/.well-known/security.txt", (request, reply) => {
    // `text/plain` and explicitly UTF-8. RFC 9116 requires the media type;
    // Fastify's default serializer would hand back JSON, which no conforming
    // reader would parse.
    void reply
      .type("text/plain; charset=utf-8")
      .send(buildSecurityTxt(request.headers.host, new Date()));
  });
}
