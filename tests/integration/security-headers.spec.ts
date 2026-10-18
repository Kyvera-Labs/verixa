import { buildApp, type SecurityHeadersOptions } from "@verixa/api/app";
import supertest from "supertest";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Transport security over a real socket (Issue 213).
 *
 * The unit spec for this plugin (`apps/api/src/plugins/security-headers.spec.ts`)
 * covers the pure pieces — directive formatting, config mapping, `Host`
 * validation. This file is about what a client actually receives: the header on
 * responses the routes never touched, a redirect that survives a `POST`, and a
 * proxy-reported scheme that must not be redirected again.
 */

const ONE_YEAR_SECONDS = 31_536_000;
const TWO_YEARS_SECONDS = 63_072_000;

const productionHsts: SecurityHeadersOptions = {
  hsts: { maxAgeSeconds: ONE_YEAR_SECONDS, includeSubDomains: true, preload: false },
  enforceHttps: false,
};

interface TestApp {
  readonly request: ReturnType<typeof supertest>;
  /**
   * Typed as what `buildApp` actually returns rather than imported as
   * `FastifyInstance` from "fastify": this package does not depend on Fastify
   * directly, so the import would resolve to `any` and every assertion on the
   * response would silently lose type checking.
   */
  readonly app: ReturnType<typeof buildApp>;
  readonly close: () => Promise<void>;
}

async function startApp(
  securityHeaders: SecurityHeadersOptions,
  trustProxy = false,
): Promise<TestApp> {
  const app = buildApp({ securityHeaders, trustProxy });
  await app.ready();

  return {
    request: supertest(app.server),
    app,
    close: () => app.close(),
  };
}

describe("Strict-Transport-Security", () => {
  let client: TestApp | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it("is sent with the configured max-age and scope", async () => {
    client = await startApp(productionHsts);

    const response = await client.request.get("/health");

    expect(response.status).toBe(200);
    expect(response.headers["strict-transport-security"]).toBe(
      `max-age=${ONE_YEAR_SECONDS}; includeSubDomains`,
    );
  });

  it("is sent on responses no route produced", async () => {
    // The header is a property of the transport, not of a handler. Registering
    // it per-route would leave every future route — and every 404, 400 and 500
    // — quietly uncovered, which is the failure mode this guards against.
    client = await startApp(productionHsts);

    const response = await client.request.get("/does-not-exist");

    expect(response.status).toBe(404);
    expect(response.headers["strict-transport-security"]).toBe(
      `max-age=${ONE_YEAR_SECONDS}; includeSubDomains`,
    );
  });

  it("carries preload only when the policy asked for it", async () => {
    client = await startApp({
      hsts: { maxAgeSeconds: TWO_YEARS_SECONDS, includeSubDomains: true, preload: true },
      enforceHttps: false,
    });

    const response = await client.request.get("/health");

    expect(response.headers["strict-transport-security"]).toBe(
      `max-age=${TWO_YEARS_SECONDS}; includeSubDomains; preload`,
    );
  });

  it("omits the header entirely for an app built without a policy", async () => {
    // `server.ts` always derives a policy from validated config; the callers
    // that pass nothing are in-process tests and the development shape, where
    // pinning `localhost` would be an own-goal.
    client = await startApp({ hsts: null, enforceHttps: false });

    const response = await client.request.get("/health");

    expect(response.status).toBe(200);
    expect(response.headers["strict-transport-security"]).toBeUndefined();
  });

  it("still sends max-age=0 rather than dropping the header, so a pin can be lifted", async () => {
    client = await startApp({
      hsts: { maxAgeSeconds: 0, includeSubDomains: false, preload: false },
      enforceHttps: false,
    });

    const response = await client.request.get("/health");

    expect(response.headers["strict-transport-security"]).toBe("max-age=0");
  });
});

describe("HTTP-to-HTTPS redirect", () => {
  let client: TestApp | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  const enforcing = {
    hsts: productionHsts.hsts,
    enforceHttps: true,
  } satisfies SecurityHeadersOptions;

  it("leaves a plaintext request alone when enforcement is off", async () => {
    client = await startApp(productionHsts);

    const response = await client.request.get("/health");

    expect(response.status).toBe(200);
    expect(response.headers.location).toBeUndefined();
  });

  it("redirects a plaintext request to the https equivalent with 308", async () => {
    client = await startApp(enforcing);

    const response = await client.request.get("/health");

    expect(response.status).toBe(308);
    // Supertest connects to an ephemeral port, so the authority is
    // `127.0.0.1:<port>` — asserted as a pattern rather than a fixed port for
    // the same reason the rest of this suite never hardcodes one.
    expect(response.headers.location).toMatch(/^https:\/\/127\.0\.0\.1:\d+\/health$/);
  });

  it("keeps the path and query", async () => {
    client = await startApp(enforcing);

    const response = await client.request.get("/auth/login?tenant=acme");

    expect(response.status).toBe(308);
    expect(response.headers.location).toMatch(
      /^https:\/\/127\.0\.0\.1:\d+\/auth\/login\?tenant=acme$/,
    );
  });

  it("does not redirect an https request the proxy reported", async () => {
    // Behind a TLS-terminating proxy the socket here is plaintext, and the only
    // thing that knows the client spoke https is `X-Forwarded-Proto`. That is
    // why `ENFORCE_HTTPS` without `TRUST_PROXY` loops: the app would never
    // believe any request was already secure.
    client = await startApp(enforcing, true);

    const response = await client.request.get("/health").set("x-forwarded-proto", "https");

    expect(response.status).toBe(200);
  });

  it("redirects when the proxy reports plaintext", async () => {
    client = await startApp(enforcing, true);

    const response = await client.request.get("/health").set("x-forwarded-proto", "http");

    expect(response.status).toBe(308);
  });

  it("ignores a forged X-Forwarded-Proto when no proxy is trusted", async () => {
    // The header is only honoured one hop away from a proxy this process knows
    // about. Accepting it otherwise would let any client declare itself secure
    // and skip the redirect that is supposed to be the whole point.
    client = await startApp(enforcing, false);

    const response = await client.request.get("/health").set("x-forwarded-proto", "https");

    expect(response.status).toBe(308);
  });

  it("sends the pin on the redirect itself", async () => {
    client = await startApp(enforcing);

    const response = await client.request.get("/health");

    expect(response.headers["strict-transport-security"]).toBe(
      `max-age=${ONE_YEAR_SECONDS}; includeSubDomains`,
    );
  });

  it("is not cacheable, because its Location came from a Host header", async () => {
    client = await startApp(enforcing);

    const response = await client.request.get("/health");

    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("refuses to redirect a Host it would be unsafe to echo", async () => {
    // `app.inject` rather than Supertest: the HTTP client derives `Host` from
    // the request URL and would overwrite anything set as a header, so a
    // crafted authority can only be sent through Fastify's own injection API.
    // The tradeoff is documented in docs/security/tls-enforcement.md — this
    // path is exercised at the framework boundary, not over a socket.
    client = await startApp(enforcing);

    const response = await client.app.inject({
      method: "GET",
      url: "/health",
      headers: { host: "verixa.test@attacker.example" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers.location).toBeUndefined();
    expect(response.body).not.toContain("attacker.example");
  });

  it("redirects a POST with 308 so the method and body survive the retry", async () => {
    // A 301 lets a user agent turn the follow-up request into a GET, which
    // would silently discard the credentials in a `/auth/login` body. The
    // route is not even registered here (no container), and that is the point:
    // the redirect happens before routing, so no request body is consumed.
    client = await startApp(enforcing);

    const response = await client.request
      .post("/auth/login")
      .send({ email: "someone@example.com", password: "hunter2-not-sent" });

    expect(response.status).toBe(308);
    expect(response.headers.location).toMatch(/^https:\/\/127\.0\.0\.1:\d+\/auth\/login$/);
    // The hook answers before routing, so nothing consumes the body and nothing
    // echoes it back — a redirect that reflected the credentials it was
    // protecting would be a very elaborate way of sending them twice.
    expect(response.text).toBe("");
  });
});
