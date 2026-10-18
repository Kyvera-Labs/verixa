import { createServer, request as httpRequest } from "node:http";
import type { Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  CSRF_COOKIE_NAME,
  CSRF_COOKIE_PATH,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  clearedSessionCookies,
  csrfTokenCookie,
  expireCookie,
  refreshTokenCookie,
  serializeCookie,
  sessionCookies,
  type CookieAttributes,
} from "./cookie-config.js";

/**
 * The cookie policy for the sessions context (roadmap Issue 214).
 *
 * Two halves. The first is the attribute decisions themselves — the refresh
 * token is `HttpOnly`, the CSRF token is not, `Path` scopes the credential to
 * the one endpoint that needs it, and no `Domain` is ever emitted so every
 * cookie stays host-only. The second is the wire: a `Set-Cookie` is a header,
 * headers are a framing format, and the only way to know the serialized strings
 * arrive as two cookies rather than one mangled one is to read them off a
 * socket.
 */

const REFRESH_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const CSRF_MAX_AGE_SECONDS = 60 * 60;

const EPOCH_UTC = "Thu, 01 Jan 1970 00:00:00 GMT";

const REFRESH_COOKIE_HEADER =
  `${REFRESH_COOKIE_NAME}=R-1; Path=${REFRESH_COOKIE_PATH}; ` +
  `Max-Age=${String(REFRESH_MAX_AGE_SECONDS)}; HttpOnly; Secure; SameSite=Lax`;

const CSRF_COOKIE_HEADER =
  `${CSRF_COOKIE_NAME}=C-1; Path=${CSRF_COOKIE_PATH}; ` +
  `Max-Age=${String(CSRF_MAX_AGE_SECONDS)}; Secure; SameSite=Lax`;

/** What a login hands out: the two cookies, serialized, in order. */
function issuedCookies(): readonly string[] {
  return sessionCookies({
    refreshToken: "R-1",
    csrfToken: "C-1",
    sessionMaxAgeSeconds: REFRESH_MAX_AGE_SECONDS,
    csrfMaxAgeSeconds: CSRF_MAX_AGE_SECONDS,
  });
}

/**
 * A cookie with every field this module requires filled in, one field overrode.
 *
 * Written as a factory with conditional spreads rather than a type that allows
 * `undefined`: under `exactOptionalPropertyTypes`, `{ maxAgeSeconds: undefined }`
 * is not the same as omitting the key, and the difference is a compile error
 * only if the call site spells it out.
 */
function attributes(
  overrides: Partial<CookieAttributes> & { readonly name: string },
): CookieAttributes {
  return {
    name: overrides.name,
    value: overrides.value ?? "token-value",
    path: overrides.path ?? "/",
    httpOnly: overrides.httpOnly ?? true,
    secure: overrides.secure ?? true,
    sameSite: overrides.sameSite ?? "Lax",
    ...(overrides.maxAgeSeconds === undefined ? {} : { maxAgeSeconds: overrides.maxAgeSeconds }),
    ...(overrides.expires === undefined ? {} : { expires: overrides.expires }),
    ...(overrides.partitioned === undefined ? {} : { partitioned: overrides.partitioned }),
  };
}

describe("serializeCookie", () => {
  it("writes the refresh cookie in full", () => {
    expect(
      serializeCookie(refreshTokenCookie({ token: "R-1", maxAgeSeconds: REFRESH_MAX_AGE_SECONDS })),
    ).toBe(REFRESH_COOKIE_HEADER);
  });

  it("leaves HttpOnly off the CSRF cookie, on purpose", () => {
    const serialized = serializeCookie(
      csrfTokenCookie({ token: "C-1", maxAgeSeconds: CSRF_MAX_AGE_SECONDS }),
    );

    expect(serialized).toBe(CSRF_COOKIE_HEADER);
    expect(serialized).not.toContain("HttpOnly");
  });

  it("accepts every token shape the platform actually issues", () => {
    // Base64url (with `-` and `_`), standard base64 (with `+`, `/` and `=`
    // padding), a dotted JWT, and lower-case hex. A character class that
    // accidentally excludes one of these breaks login at the serialization
    // boundary rather than in the token code, which is the worst place to find
    // out — so all four are pinned here.
    const values = [
      "AbC-_9",
      "ab+/cd==",
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "0f4e8a1b9c2d3e4f",
    ];

    for (const value of values) {
      expect(serializeCookie(attributes({ name: REFRESH_COOKIE_NAME, value }))).toContain(
        `=${value};`,
      );
    }
  });

  it("sends an empty value, which is how a cookie is deleted", () => {
    expect(serializeCookie(attributes({ name: CSRF_COOKIE_NAME, value: "" }))).toBe(
      `${CSRF_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax`,
    );
  });

  it("emits Expires as an IMF-fixdate", () => {
    const when = new Date(Date.UTC(2026, 9, 17, 12, 0, 0));

    expect(serializeCookie(attributes({ name: REFRESH_COOKIE_NAME, expires: when }))).toBe(
      `${REFRESH_COOKIE_NAME}=token-value; Path=/; ` +
        "Expires=Sat, 17 Oct 2026 12:00:00 GMT; HttpOnly; Secure; SameSite=Lax",
    );
  });

  it("emits attributes in the order browsers expect, Partitioned last", () => {
    expect(
      serializeCookie(
        attributes({ name: REFRESH_COOKIE_NAME, sameSite: "None", partitioned: true }),
      ),
    ).toBe(
      `${REFRESH_COOKIE_NAME}=token-value; Path=/; HttpOnly; Secure; SameSite=None; Partitioned`,
    );
  });

  it("omits Max-Age and Expires when the cookie has no lifetime of its own", () => {
    const serialized = serializeCookie(attributes({ name: REFRESH_COOKIE_NAME }));

    expect(serialized).not.toContain("Max-Age");
    expect(serialized).not.toContain("Expires");
  });

  it("never emits a Domain, so the cookie stays host-only", () => {
    // `Domain` is the attribute that hands a cookie to subdomains the
    // deployment does not control. There is no input path that can set it —
    // `CookieAttributes` has no `domain` field at all, which is why grepping
    // for the word is the whole audit of the `Domain` question.
    expect(
      serializeCookie(refreshTokenCookie({ token: "R-1", maxAgeSeconds: 3600 })),
    ).not.toContain("Domain");
  });

  describe("refuses a value that could end the cookie early", () => {
    // Each of these is the same attack in a different spelling: the value stops
    // being a value and starts being an attribute, a header, or a second
    // cookie.
    const injected: readonly (readonly [string, string])[] = [
      ["semicolon", "R-1; HttpOnly"],
      ["comma", "R-1, other=1"],
      ["double quote", 'R-1"x'],
      ["backslash", "R-1\\x"],
      ["space", "R-1 x"],
      ["newline", "R-1\r\nSet-Cookie: evil=1"],
      ["control character", "R-1\x00x"],
      ["non-ASCII", "R-1é"],
    ];

    it.each(injected)("refuses a value containing a %s", (_label, value) => {
      expect(() => serializeCookie(attributes({ name: REFRESH_COOKIE_NAME, value }))).toThrow(
        RangeError,
      );
    });

    it("does not quote the rejected value back in the message", () => {
      // The message ends up in a log, and the value is precisely the string
      // that was trying to inject something.
      try {
        serializeCookie(attributes({ name: REFRESH_COOKIE_NAME, value: "R-1; evil=1" }));
        expect.unreachable("serializeCookie should have thrown");
      } catch (error) {
        const message = (error as RangeError).message;

        expect(message).not.toContain("evil");
        expect(message).toContain(REFRESH_COOKIE_NAME);
      }
    });

    it.each([
      ["semicolon", "verixa;refresh"],
      ["equals", "verixa=refresh"],
      ["space", "verixa refresh"],
      ["empty name", ""],
    ])("refuses a name containing a %s", (_label, name) => {
      expect(() => serializeCookie(attributes({ name, value: "ok" }))).toThrow(RangeError);
    });

    it.each([
      ["a relative path", "auth/refresh"],
      ["a path containing a semicolon", "/auth/refresh; HttpOnly"],
      ["a path containing a newline", "/auth/refre\nsh"],
      ["an empty path", ""],
    ])("refuses %s", (_label, path) => {
      expect(() => serializeCookie(attributes({ name: REFRESH_COOKIE_NAME, path }))).toThrow(
        RangeError,
      );
    });
  });

  describe("refuses the attribute combinations browsers silently drop", () => {
    it("SameSite=None without Secure", () => {
      expect(() =>
        serializeCookie(attributes({ name: REFRESH_COOKIE_NAME, sameSite: "None", secure: false })),
      ).toThrow(/SameSite=None requires Secure/);
    });

    it("Partitioned without Secure", () => {
      expect(() =>
        serializeCookie(
          attributes({ name: REFRESH_COOKIE_NAME, partitioned: true, secure: false }),
        ),
      ).toThrow(/Partitioned requires Secure/);
    });

    const invalidMaxAges: readonly (readonly [string, number])[] = [
      ["a fraction", 3600.5],
      ["a negative number", -1],
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
    ];

    it.each(invalidMaxAges)("refuses %s as Max-Age", (_label, maxAgeSeconds) => {
      expect(() =>
        serializeCookie(attributes({ name: REFRESH_COOKIE_NAME, maxAgeSeconds })),
      ).toThrow(/Max-Age must be a non-negative integer/);
    });
  });
});

describe("refreshTokenCookie", () => {
  it("is HttpOnly, Secure and scoped to the refresh endpoint", () => {
    expect(refreshTokenCookie({ token: "R-1", maxAgeSeconds: REFRESH_MAX_AGE_SECONDS })).toEqual({
      name: REFRESH_COOKIE_NAME,
      value: "R-1",
      path: REFRESH_COOKIE_PATH,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAgeSeconds: REFRESH_MAX_AGE_SECONDS,
    });
  });
});

describe("csrfTokenCookie", () => {
  it("is readable by script, Secure, and scoped to the whole origin", () => {
    expect(csrfTokenCookie({ token: "C-1", maxAgeSeconds: CSRF_MAX_AGE_SECONDS })).toEqual({
      name: CSRF_COOKIE_NAME,
      value: "C-1",
      path: CSRF_COOKIE_PATH,
      httpOnly: false,
      secure: true,
      sameSite: "Lax",
      maxAgeSeconds: CSRF_MAX_AGE_SECONDS,
    });
  });
});

describe("expireCookie", () => {
  it("keeps the fields a browser matches on and empties the rest", () => {
    const original = refreshTokenCookie({ token: "R-1", maxAgeSeconds: REFRESH_MAX_AGE_SECONDS });

    expect(expireCookie(original)).toEqual({
      name: REFRESH_COOKIE_NAME,
      value: "",
      path: REFRESH_COOKIE_PATH,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAgeSeconds: 0,
      expires: new Date(0),
    });
  });

  it("carries Partitioned through, since that too is part of the match", () => {
    const partitioned = attributes({
      name: REFRESH_COOKIE_NAME,
      path: REFRESH_COOKIE_PATH,
      partitioned: true,
    });

    expect(expireCookie(partitioned).partitioned).toBe(true);
  });

  it("omits Partitioned when the original cookie had none", () => {
    expect(
      expireCookie(refreshTokenCookie({ token: "", maxAgeSeconds: 0 })).partitioned,
    ).toBeUndefined();
  });

  it("produces a header that clears the cookie rather than a different one", () => {
    expect(serializeCookie(expireCookie(refreshTokenCookie({ token: "", maxAgeSeconds: 0 })))).toBe(
      `${REFRESH_COOKIE_NAME}=; Path=${REFRESH_COOKIE_PATH}; Max-Age=0; Expires=${EPOCH_UTC}; ` +
        "HttpOnly; Secure; SameSite=Lax",
    );
  });
});

describe("sessionCookies", () => {
  it("issues the credential and the CSRF token together", () => {
    expect(issuedCookies()).toEqual([REFRESH_COOKIE_HEADER, CSRF_COOKIE_HEADER]);
  });

  it("refuses to issue either cookie when one value will not serialize", () => {
    // Partial failure here is the bad outcome: a session whose CSRF cookie was
    // dropped leaves a client that cannot make a single state-changing request.
    expect(() =>
      sessionCookies({
        refreshToken: "R-1; evil=1",
        csrfToken: "C-1",
        sessionMaxAgeSeconds: REFRESH_MAX_AGE_SECONDS,
        csrfMaxAgeSeconds: CSRF_MAX_AGE_SECONDS,
      }),
    ).toThrow(RangeError);
  });
});

describe("clearedSessionCookies", () => {
  it("clears both cookies, each with its own path", () => {
    expect(clearedSessionCookies()).toEqual([
      `${REFRESH_COOKIE_NAME}=; Path=${REFRESH_COOKIE_PATH}; Max-Age=0; Expires=${EPOCH_UTC}; ` +
        "HttpOnly; Secure; SameSite=Lax",
      `${CSRF_COOKIE_NAME}=; Path=${CSRF_COOKIE_PATH}; Max-Age=0; Expires=${EPOCH_UTC}; ` +
        "Secure; SameSite=Lax",
    ]);
  });
});

describe("on the wire", () => {
  let server: Server | undefined;

  afterEach(async () => {
    const listening = server;
    server = undefined;

    if (listening === undefined) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      listening.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  });

  /**
   * Every `Set-Cookie` line, in the order they were sent.
   *
   * Read from `rawHeaders` rather than `res.headers["set-cookie"]`: Node's own
   * header parsing is the thing that would have to merge or split a malformed
   * cookie, and the point of this section is that the serialized value never
   * reaches it in a state where that could happen.
   */
  function setCookieLines(rawHeaders: readonly string[]): readonly string[] {
    const lines: string[] = [];

    for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
      const name = rawHeaders[index];
      const value = rawHeaders[index + 1];

      if (name !== undefined && value !== undefined && name.toLowerCase() === "set-cookie") {
        lines.push(value);
      }
    }

    return lines;
  }

  function cookieAt(lines: readonly string[], index: number): string {
    const line = lines[index];

    if (line === undefined) {
      throw new Error(`Expected a Set-Cookie header at index ${String(index)}.`);
    }

    return line;
  }

  /**
   * A server that writes the policy's output into real response headers.
   *
   * `@verixa/sessions` has no HTTP framework, and adding one to test a header
   * would be the tail wagging the dog: `Set-Cookie` is a plain header, so
   * `node:http` exercises the same boundary a Fastify reply would, with no new
   * dependency and nothing in the fixture that could disagree with the policy.
   */
  async function serve(...headers: readonly string[]): Promise<readonly string[]> {
    const listening = createServer((_request, response) => {
      response.setHeader("set-cookie", [...headers]);
      response.end("{}");
    });
    server = listening;

    await new Promise<void>((resolve, reject) => {
      listening.once("error", reject);
      listening.listen(0, "127.0.0.1", resolve);
    });

    const address = listening.address();

    if (address === null || typeof address === "string") {
      throw new Error("Expected the test server to bind an IPv4 port.");
    }

    return new Promise((resolve, reject) => {
      const request = httpRequest(
        { host: "127.0.0.1", port: address.port, path: "/" },
        (response) => {
          response.resume();
          response.on("end", () => {
            resolve(setCookieLines(response.rawHeaders));
          });
          response.on("error", reject);
        },
      );

      request.on("error", reject);
      request.end();
    });
  }

  it("arrives as two separate cookies for one session", async () => {
    const lines = await serve(...issuedCookies());

    expect(lines).toHaveLength(2);
    expect(cookieAt(lines, 0)).toBe(REFRESH_COOKIE_HEADER);
    expect(cookieAt(lines, 1)).toBe(CSRF_COOKIE_HEADER);
  });

  it("keeps the attributes intact across the socket", async () => {
    const lines = await serve(
      serializeCookie(refreshTokenCookie({ token: "R-1", maxAgeSeconds: REFRESH_MAX_AGE_SECONDS })),
    );
    const refresh = cookieAt(lines, 0);

    expect(refresh).toBe(REFRESH_COOKIE_HEADER);
    expect(refresh).toContain("HttpOnly");
    expect(refresh).toContain("Secure");
    expect(refresh).toContain("SameSite=Lax");
    expect(refresh).toContain(`Path=${REFRESH_COOKIE_PATH}`);
    expect(refresh).not.toContain("Domain");
  });

  it("sends the clear instructions unchanged", async () => {
    const lines = await serve(...clearedSessionCookies());

    expect(lines).toHaveLength(2);
    expect(cookieAt(lines, 0)).toMatch(/^verixa_refresh=;/);
    expect(cookieAt(lines, 0)).toContain("Max-Age=0");
    expect(cookieAt(lines, 0)).toContain(`Expires=${EPOCH_UTC}`);
    expect(cookieAt(lines, 1)).toContain(`Path=${CSRF_COOKIE_PATH}`);
  });
});
