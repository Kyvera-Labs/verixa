/**
 * Cookie attributes for the sessions context. Route handlers request cookies by purpose
 * (`refreshTokenCookie`, `csrfTokenCookie`) and never set attributes themselves, so the policy
 * lives in one place. Framework-free: it returns `Set-Cookie` strings.
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
 * Path the refresh cookie is scoped to, so the token is sent only to the refresh endpoint and never
 * to other paths on the same host. This limits exposure; it is not an XSS boundary.
 */
export const REFRESH_COOKIE_PATH = "/auth/refresh";

/** The CSRF token has to be readable from every page that renders a form. */
export const CSRF_COOKIE_PATH = "/";

/**
 * Valid cookie names: RFC 6265 §4.1.1 tokens (printable ASCII without separators). Rejecting `;`,
 * `=`, `,`, whitespace and control characters prevents cookie injection and response splitting.
 * Every token Verixa issues already matches.
 */
const COOKIE_NAME = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

/**
 * RFC 6265 §4.1.2 cookie-value: printable ASCII except `"`, `,`, `;` and `\`, written as the RFC's
 * ranges. `=` stays allowed for base64 padding, and an empty value is allowed so a cookie can be
 * cleared.
 */
const COOKIE_VALUE = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/;

/**
 * RFC 6265 §4.1.2.4 path-value: the cookie-value characters, non-empty and starting with `/`.
 * Validated because attributes are built by string concatenation.
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
 * The `Set-Cookie` header value. Attributes follow the RFC 6265bis order that every current engine
 * accepts. `HttpOnly` and `Secure` are omitted when unset, so their absence on the CSRF cookie is
 * visibly deliberate.
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
 * Attributes that delete a cookie. Derived from the original attributes, because a browser only
 * deletes a cookie whose name, `Domain` and `Path` match. Sends both `Max-Age=0` and an epoch
 * `Expires` for older clients.
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
 * - `HttpOnly`: it is a long-lived bearer credential, and script access would let any XSS steal it.
 * - `Secure` in every environment. If the browser refuses to store it locally, use `localhost` or a
 *   trusted local certificate rather than relaxing the flag (see docs/security/tls-enforcement.md).
 * - `SameSite=Lax`: still blocks cross-site POSTs, while `Strict` would drop the cookie on
 *   top-level navigation into the app, such as an email link or IdP redirect.
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
 * The CSRF token cookie, deliberately readable by JavaScript: double-submit CSRF requires the page
 * to read it and echo it in a header. It grants nothing on its own; the refresh cookie stays
 * `HttpOnly` (see docs/security/secure-cookies.md).
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
