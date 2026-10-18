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
 * Whether a `Host` header value is a host: labels, and an optional port.
 *
 * `Canonical` is echoed into the response body, so it is the one field this
 * document builds from client-supplied data. Anything outside this pattern —
 * a space, a newline, a slash followed by a path — means the header is not a
 * host, and is dropped rather than rendered. Injecting a forged line into a
 * machine-readable security contact would be a small but real way to make this
 * document lie about where to send a report.
 *
 * The bounds are RFC 1035's: 253 characters for a name, 5 for a port. Host and
 * port are matched separately rather than as one pattern with an optional
 * group, which keeps each check a single pass over its own slice with nothing
 * to backtrack, on an input this server does not control.
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

  return (
    HOST_NAME.test(value.slice(0, separator)) && PORT_NUMBER.test(value.slice(separator + 1))
  );
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
 * The next 1 January at least `MINIMUM_HORIZON_DAYS` out.
 *
 * An expiry is a liveness signal: a researcher who finds this file in two
 * years needs to know whether the contact details in it are still watched.
 * The obvious implementation is a date hardcoded next to the text, which is
 * correct exactly once and then silently wrong — the file keeps serving, and
 * the `Expires` it advertises passed months ago. The alternative rejected is
 * "now plus a year" computed per request, which never expires and so stops
 * meaning anything. Rolling to the next New Year keeps both properties: the
 * value is always in the future, and it still names a real date by which a
 * human is expected to have re-read this file.
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
 * Register the route.
 *
 * Takes no container: this answers a question about the *software*, not about
 * a tenant's data, so it must work on a process that has no database. That is
 * the same reasoning that keeps `/health` container-free, and it matters here
 * for a sharper reason — a researcher's scanner should reach the disclosure
 * channel whether or not the deployment's database is up, and a 503 from the
 * one endpoint whose job is to be found is worse than no endpoint.
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
