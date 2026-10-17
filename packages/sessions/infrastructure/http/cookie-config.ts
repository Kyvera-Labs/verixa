/**
 * Cookie attributes for the sessions context (roadmap Issue 214).
 *
 * One place decides what a Verixa cookie looks like on the wire, so the
 * question "is this cookie HttpOnly?" has exactly one answer to go and read.
 * Route handlers ask for a cookie by purpose — `refreshTokenCookie`,
 * `csrfTokenCookie` — and never spell out attributes themselves, which is the
 * only arrangement in which a future change to the policy is a one-line change
 * rather than an audit of every call site.
 *
 * Nothing here imports a web framework, and that is deliberate: `@verixa/sessions`
 * has no Fastify dependency and a cookie is, at the boundary that matters, just
 * a `Set-Cookie` string. The HTTP layer's job is to put the returned value in a
 * header; it gets no vote on the attributes.
 */

/** The `SameSite` modes, in the casing `Set-Cookie` is conventionally written in. */
export type SameSiteMode = "Strict" | "Lax" | "None";

/**
 * A fully-specified cookie, before serialization.
 *
 * `domain` is absent by design rather than by omission: omitting it produces a
 * **host-only** cookie, and setting it hands the cookie to every subdomain of
 * the registrable domain, including ones this deployment does not control and
 * ones that will exist in two years. See `docs/security/secure-cookies.md`.
 */
export interface CookieAttributes {
  readonly name: string;
  readonly value: string;
  readonly path: string;
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly sameSite: SameSiteMode;
  readonly maxAgeSeconds?: number;
  readonly expires?: Date;
  readonly partitioned?: boolean;
}

/** Session refresh token. Named for what it is, because the name is public. */
export const REFRESH_COOKIE_NAME = "verixa_refresh";

/**
 * The CSRF token, read by JavaScript on purpose.
 *
 * Its name says `csrf` and nothing about a session because the value is not a
 * credential: it proves only that the caller could read this origin's cookies,
 * and it is checked *alongside* `verixa_refresh`, never instead of it.
 */
export const CSRF_COOKIE_NAME = "verixa_csrf";

/**
 * Path the refresh cookie is scoped to.
 *
 * A cookie's `Path` is not a security boundary against XSS (a script on any
 * page of the origin can still make the request that carries it), but it does
 * decide *when the value leaves the browser at all*. Scoped to one endpoint,
 * the refresh token is absent from every other request — including requests to
 * paths served by something else on the same host, and including anything a
 * permissive `Path=/` arrangement would have leaked into logs upstream.
 */
export const REFRESH_COOKIE_PATH = "/auth/refresh";

/** The CSRF token has to be readable from every page that renders a form. */
export const CSRF_COOKIE_PATH = "/";

/**
 * Cookie names are matched against this before serialization.
 *
 * RFC 6265 §4.1.1 builds a cookie out of RFC 2616 `token`s, and a token is the
 * printable ASCII set minus the separators — which is what the class below
 * spells out. So no name can contain `;`, `=`, `,`, whitespace or a control
 * character.
 *
 * Rejecting those is not pedantry. A `;` ends the attribute list early, so
 * `token=abc; HttpOnly` arriving from somewhere the application did not
 * generate becomes two cookies, the second one named `HttpOnly`; a `;` in a
 * name ends the name before its own `=`. Both are cookie injection, and a
 * newline in either is response splitting one layer up.
 *
 * Base64url, JWTs (`.`-separated base64url) and hex all satisfy this, so no
 * token Verixa actually issues is affected — the checks exist for the value
 * some future caller passes in.
 */
const COOKIE_NAME = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

/**
 * RFC 6265 §4.1.2 cookie-value, as the five ranges the RFC lists: printable
 * ASCII except `"`, `,`, `;` and `\`.
 *
 * Written as allowed ranges rather than a negated class for two reasons. The
 * four forbidden characters then read as the gaps between the ranges, which is
 * easier to check than four entries inside a `^` set that are easy to typo out.
 * And `=` (0x3D) sits inside `%x3C-5B`, so it stays permitted — base64 padding
 * needs it, and a class built by hand around the separators is exactly how an
 * `=` gets lost.
 *
 * The empty value is allowed: clearing a cookie sends `name=`, so a pattern
 * requiring at least one character would make every logout path throw.
 */
const COOKIE_VALUE = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/;

/**
 * RFC 6265 §4.1.2.4 path-value: the cookie-value character set, non-empty, and
 * anchored at `/`.
 *
 * `Path` is validated on the same terms as the value even though this package
 * only ever passes a constant, because the attribute is assembled by string
 * concatenation like every other one — a caller that interpolated a request
 * path into it would get the same injection out of `Path` that a `;` in a value
 * gives.
 */
const COOKIE_PATH = /^\/[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/;

const FORBIDDEN =
  "is outside the RFC 6265 character set. A semicolon ends the attribute list early " +
  "and turns one cookie into two; a control character would let this field start a " +
  "header of its own in the response.";

function assertCookieField(
  cookieName: string,
  field: "name" | "value" | "path",
  value: string,
): void {
  const pattern = field === "name" ? COOKIE_NAME : field === "path" ? COOKIE_PATH : COOKIE_VALUE;

  if (pattern.test(value)) {
    return;
  }

  // The offending value is never quoted back — it is the thing that just failed
  // a check for containing header syntax. A name is only named once it has
  // itself passed, which is why `serializeCookie` validates it first.
  const subject = field === "name" ? "A cookie name" : `Cookie "${cookieName}" has a ${field} that`;

  throw new RangeError(`${subject} ${FORBIDDEN}`);
}

/**
 * The `Set-Cookie` field value for a cookie.
 *
 * Attribute order is not cosmetic. A `Partitioned` cookie must already be
 * `Secure`, and browsers stop parsing at the first attribute they do not
 * recognise in some legacy paths; the sequence below is what RFC 6265-bis
 * examples use and what every current engine accepts.
 *
 * `HttpOnly` and `Secure` are emitted only when set, because their *absence* is
 * the meaningful statement for the CSRF cookie — a reader of the header should
 * be able to see that JS access was allowed on purpose.
 */
export function serializeCookie(attributes: CookieAttributes): string {
  // Order matters: the name is the only field quoted in the messages below, so
  // it has to be known-safe before anything is written about it.
  assertCookieField(attributes.name, "name", attributes.name);
  assertCookieField(attributes.name, "value", attributes.value);
  assertCookieField(attributes.name, "path", attributes.path);

  if (attributes.sameSite === "None" && !attributes.secure) {
    // Browsers refuse this combination outright (it is the pre-SameSite
    // cross-site default that got users owned), so emitting it would produce a
    // cookie that silently never stores. Failing here is the only way to make
    // that mistake visible before the response ships.
    throw new RangeError(
      `Cookie "${attributes.name}": SameSite=None requires Secure. ` +
        "A cross-site cookie sent over plaintext is readable by anyone on the path.",
    );
  }

  if (attributes.partitioned === true && !attributes.secure) {
    // CHIPS cookies are `Secure` by definition; a `Partitioned` cookie without
    // it is dropped at the same point as the `SameSite=None` case above, and
    // for the same reason — the browser is not obliged to explain itself.
    throw new RangeError(
      `Cookie "${attributes.name}": Partitioned requires Secure. ` +
        "A partitioned cookie is stored under a top-site frame that may be plaintext.",
    );
  }

  if (attributes.maxAgeSeconds !== undefined) {
    // `Max-Age` is specified in seconds and an engine that sees `Max-Age=3600.5`
    // or `Max-Age=NaN` discards the cookie without a word. A lifetime computed
    // by dividing something is the realistic way to get here.
    if (!Number.isInteger(attributes.maxAgeSeconds) || attributes.maxAgeSeconds < 0) {
      throw new RangeError(
        `Cookie "${attributes.name}": Max-Age must be a non-negative integer number of ` +
          `seconds, got ${String(attributes.maxAgeSeconds)}.`,
      );
    }
  }

  const parts = [`${attributes.name}=${attributes.value}`, `Path=${attributes.path}`];

  if (attributes.maxAgeSeconds !== undefined) {
    parts.push(`Max-Age=${attributes.maxAgeSeconds}`);
  }

  if (attributes.expires !== undefined) {
    parts.push(`Expires=${attributes.expires.toUTCString()}`);
  }

  if (attributes.httpOnly) {
    parts.push("HttpOnly");
  }

  if (attributes.secure) {
    parts.push("Secure");
  }

  parts.push(`SameSite=${attributes.sameSite}`);

  if (attributes.partitioned === true) {
    parts.push("Partitioned");
  }

  return parts.join("; ");
}

/** The Unix epoch, which is what a pre-`Max-Age` client needs to see to drop a cookie. */
const EPOCH = new Date(0);

/**
 * The cookie attributes that delete a cookie.
 *
 * Deletion is a match on name, `Domain` and `Path` — an `Expires` in the past
 * sent with `Path=/` does not remove a cookie that was set with
 * `Path=/auth/refresh`. So clearing is derived from the original attributes
 * rather than written again, which is the failure mode that turns a logout into
 * "logged out until the refresh token comes back on the next request".
 *
 * Both `Max-Age=0` and the epoch `Expires` are sent: `Max-Age` is what modern
 * engines honour, and the absolute date is what a client implementing the older
 * behaviour needs.
 */
export function expireCookie(attributes: CookieAttributes): CookieAttributes {
  return {
    name: attributes.name,
    value: "",
    path: attributes.path,
    httpOnly: attributes.httpOnly,
    secure: attributes.secure,
    sameSite: attributes.sameSite,
    maxAgeSeconds: 0,
    expires: EPOCH,
    // Carried through by the same matching rule as `Domain`: a partitioned
    // cookie is only removed by a header that says `Partitioned` too.
    ...(attributes.partitioned === undefined ? {} : { partitioned: attributes.partitioned }),
  };
}

/**
 * The refresh-token cookie.
 *
 * `HttpOnly` because the refresh token is a long-lived bearer credential whose
 * theft is not a page-load problem but an account-takeover problem; readable by
 * script, it is exfiltrated by any XSS on the origin, and unlike an access
 * token it can be replayed for weeks and survives rotation of the access token.
 *
 * `Secure` in every environment, including development — see
 * `docs/security/tls-enforcement.md` for why the *transport* is allowed to be
 * plaintext locally while a cookie flag is not. `Secure` is not a switch this
 * package exposes, because the difference between "development" and
 * "production" is a deployment's claim about itself, and a cookie that is
 * readable over plaintext wherever a flag happens to be unset is the exact
 * credential this file exists to protect. The consequence is deliberate: if the
 * browser refuses to store this cookie, the origin is not one it treats as
 * trustworthy, and the fix is to reach the API over `localhost` or a locally
 * trusted certificate — not to relax the attribute.
 *
 * `SameSite=Lax` rather than `Strict`: `Strict` would also drop the cookie from
 * a top-level navigation *into* the app (a link clicked from an email or an
 * IdP redirect), and the refresh that follows is the one thing that flow needs.
 * `Lax` still refuses the cross-site *sub-requests* that carry a CSRF attack —
 * the cookie is never sent with a cross-site `POST`. The alternative, `Strict`,
 * was rejected on usability rather than safety grounds; a deployment that never
 * does server-side renders can tighten it, and this is the file to do it in.
 */
export function refreshTokenCookie(input: {
  readonly token: string;
  readonly maxAgeSeconds: number;
}): CookieAttributes {
  return {
    name: REFRESH_COOKIE_NAME,
    value: input.token,
    path: REFRESH_COOKIE_PATH,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAgeSeconds: input.maxAgeSeconds,
  };
}

/**
 * The CSRF token cookie — the one cookie that is deliberately readable by
 * JavaScript.
 *
 * A double-submit CSRF token is not a secret from the page it was issued to:
 * its whole job is to be read back by script and echoed into a header, so the
 * server can check that whoever sent the request could also read this origin's
 * cookies. `HttpOnly` would defeat the mechanism.
 *
 * That exception is tolerable because the value grants nothing on its own. The
 * refresh cookie above is the credential, and it stays `HttpOnly`; an attacker
 * who steals this one still has to cause a request the browser will not make
 * cross-site. `docs/security/secure-cookies.md` keeps the reasoning where a
 * reviewer of the CSRF implementation (Issue 205) will find it.
 */
export function csrfTokenCookie(input: {
  readonly token: string;
  readonly maxAgeSeconds: number;
}): CookieAttributes {
  return {
    name: CSRF_COOKIE_NAME,
    value: input.token,
    path: CSRF_COOKIE_PATH,
    httpOnly: false,
    secure: true,
    sameSite: "Lax",
    maxAgeSeconds: input.maxAgeSeconds,
  };
}

/**
 * Both cookies for a newly-established session, in the order they should be
 * written.
 *
 * Returned as serialized strings rather than a `CookieAttributes` pair because
 * the caller's only valid action is "put these two in the response", and one
 * array means a route cannot set the session and forget the CSRF token — the
 * pair is issued together or not at all.
 */
export function sessionCookies(input: {
  readonly refreshToken: string;
  readonly csrfToken: string;
  readonly sessionMaxAgeSeconds: number;
  readonly csrfMaxAgeSeconds: number;
}): readonly string[] {
  return [
    serializeCookie(
      refreshTokenCookie({
        token: input.refreshToken,
        maxAgeSeconds: input.sessionMaxAgeSeconds,
      }),
    ),
    serializeCookie(
      csrfTokenCookie({ token: input.csrfToken, maxAgeSeconds: input.csrfMaxAgeSeconds }),
    ),
  ];
}

/**
 * The same two cookies, cleared.
 *
 * Logout has to clear both: leaving a stale CSRF cookie behind is not a
 * vulnerability by itself, but it *is* a cookie whose value no longer maps to
 * anything server-side, which is how "the second login in this tab returns
 * 403" bugs start.
 */
export function clearedSessionCookies(): readonly string[] {
  return [
    serializeCookie(
      expireCookie(
        refreshTokenCookie({
          token: "",
          maxAgeSeconds: 0,
        }),
      ),
    ),
    serializeCookie(
      expireCookie(
        csrfTokenCookie({
          token: "",
          maxAgeSeconds: 0,
        }),
      ),
    ),
  ];
}
