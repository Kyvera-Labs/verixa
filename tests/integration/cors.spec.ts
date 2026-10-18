import { buildApp, type CorsPolicy } from "@verixa/api/app";
import supertest from "supertest";
import { afterEach, describe, expect, it } from "vitest";

/**
 * CORS policy over a real socket (Issue 204).
 *
 * The property that matters is what a browser sees, so these assert on real
 * responses rather than on the options object: which origins receive the
 * `Access-Control-*` headers, which requests are refused outright, and what
 * happens on a preflight. `/health` is the sample route because it exists
 * without a database.
 */

const APP_ORIGIN = "https://app.example.com";
const ADMIN_ORIGIN = "https://admin.example.com";

interface TestApp {
  readonly request: ReturnType<typeof supertest>;
  readonly close: () => Promise<void>;
}

async function startApp(cors: CorsPolicy): Promise<TestApp> {
  const app = buildApp({ cors });
  await app.ready();

  return {
    request: supertest(app.server),
    close: () => app.close(),
  };
}

describe("CORS policy", () => {
  let client: TestApp | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  const restricted: CorsPolicy = {
    allowedOrigins: [APP_ORIGIN, ADMIN_ORIGIN],
    allowCredentials: false,
  };

  it("allows an allowlisted origin and reflects it, not the wildcard", async () => {
    client = await startApp(restricted);

    const response = await client.request.get("/health").set("Origin", APP_ORIGIN);

    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe(APP_ORIGIN);
  });

  it("rejects a request from an origin that is not on the allowlist", async () => {
    client = await startApp(restricted);

    const response = await client.request.get("/health").set("Origin", "https://evil.example");

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: "forbidden_origin" });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("refuses a suffix lookalike of an allowlisted origin", async () => {
    client = await startApp(restricted);

    const response = await client.request
      .get("/health")
      .set("Origin", "https://evil-app.example.com");

    expect(response.status).toBe(403);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("leaves a request with no Origin header alone", async () => {
    // Server-side clients, curl and same-origin navigations are not CORS
    // requests. Refusing them would turn a browser-only policy into an outage.
    client = await startApp(restricted);

    const response = await client.request.get("/health");

    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("denies every origin when the allowlist is empty", async () => {
    client = await startApp({ allowedOrigins: [], allowCredentials: false });

    const response = await client.request.get("/health").set("Origin", APP_ORIGIN);

    expect(response.status).toBe(403);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  describe("credentialed requests", () => {
    it("sends Allow-Credentials and reflects the specific origin when enabled", async () => {
      client = await startApp({ allowedOrigins: [APP_ORIGIN], allowCredentials: true });

      const response = await client.request.get("/health").set("Origin", APP_ORIGIN);

      expect(response.status).toBe(200);
      expect(response.headers["access-control-allow-origin"]).toBe(APP_ORIGIN);
      expect(response.headers["access-control-allow-credentials"]).toBe("true");
    });

    it("omits Allow-Credentials when credentials are off", async () => {
      client = await startApp(restricted);

      const response = await client.request.get("/health").set("Origin", APP_ORIGIN);

      expect(response.status).toBe(200);
      expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
    });

    it("allows the wildcard only while credentials are off", async () => {
      client = await startApp({ allowedOrigins: ["*"], allowCredentials: false });

      const response = await client.request
        .get("/health")
        .set("Origin", "https://anything.example");

      expect(response.status).toBe(200);
      expect(response.headers["access-control-allow-origin"]).toBe("*");
      expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
    });
  });

  describe("preflight", () => {
    it("answers an allowlisted preflight with the CORS headers", async () => {
      client = await startApp({ allowedOrigins: [APP_ORIGIN], allowCredentials: true });

      const response = await client.request
        .options("/health")
        .set("Origin", APP_ORIGIN)
        .set("Access-Control-Request-Method", "GET");

      expect(response.status).toBe(204);
      expect(response.headers["access-control-allow-origin"]).toBe(APP_ORIGIN);
      expect(response.headers["access-control-allow-credentials"]).toBe("true");
    });

    it("rejects a preflight from a non-allowlisted origin", async () => {
      client = await startApp(restricted);

      const response = await client.request
        .options("/health")
        .set("Origin", "https://evil.example")
        .set("Access-Control-Request-Method", "POST");

      expect(response.status).toBe(403);
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    });
  });
});
