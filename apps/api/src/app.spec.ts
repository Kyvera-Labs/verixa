import supertest from "supertest";
import { describe, expect, it, afterAll } from "vitest";

import { buildApp } from "./app.js";
import type { Container } from "./composition-root.js";

describe("buildApp with a container", () => {
  // Registration only closes over these; no use case runs during boot.
  const container = { identity: {}, authorization: {}, audit: {} } as unknown as Container;
  const app = buildApp({ container });

  afterAll(async () => {
    await app.close();
  });

  it("boots with the GraphQL server alongside the registered-schema guard", async () => {
    // The guard once applied to every route and rejected Mercurius's own
    // `/graphql` querystring schema, so the server refused to start.
    await app.ready();

    const graphql = await app.inject({
      method: "POST",
      url: "/graphql",
      payload: { query: "{ _service }" },
    });
    expect(graphql.json<unknown>()).toEqual({ data: { _service: "verixa-api" } });

    // A REST route under the guard is still mounted at its public prefix.
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: {} });
    expect(login.statusCode).toBe(400);
  });
});

describe("GET /health", () => {
  const app = buildApp();

  afterAll(async () => {
    await app.close();
  });

  it("responds with 200 and status ok", async () => {
    await app.ready();
    const response = await supertest(app.server).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });
});

describe("GET /version", () => {
  const app = buildApp();

  afterAll(async () => {
    await app.close();
  });

  it("returns the build version supplied by the deployment", async () => {
    const previous = process.env["VERIXA_BUILD_VERSION"];
    process.env["VERIXA_BUILD_VERSION"] = "ci-smoke-a";
    try {
      await app.ready();
      const response = await supertest(app.server).get("/version");
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ version: "ci-smoke-a" });
    } finally {
      if (previous === undefined) delete process.env["VERIXA_BUILD_VERSION"];
      else process.env["VERIXA_BUILD_VERSION"] = previous;
    }
  });
});

describe("Rate limiting plugin registration", () => {
  it("registers rate-limiting plugin and enforces limits on requests", async () => {
    const app = buildApp({ rateLimit: { defaultMax: 2, defaultTimeWindowMs: 60_000 } });
    // Health probes are exempt (they must never be throttled), so exercise an
    // ordinary route.
    app.get("/limited", () => ({ ok: true }));
    await app.ready();

    const res1 = await app.inject({ method: "GET", url: "/limited" });
    expect(res1.statusCode).toBe(200);
    expect(res1.headers["x-ratelimit-limit"]).toBe("2");
    expect(res1.headers["x-ratelimit-remaining"]).toBe("1");

    const res2 = await app.inject({ method: "GET", url: "/limited" });
    expect(res2.statusCode).toBe(200);
    expect(res2.headers["x-ratelimit-remaining"]).toBe("0");

    const res3 = await app.inject({ method: "GET", url: "/limited" });
    expect(res3.statusCode).toBe(429);
    expect(res3.headers["retry-after"]).toBeDefined();

    // The liveness probe stays reachable while the client is throttled.
    const probe = await app.inject({ method: "GET", url: "/health" });
    expect(probe.statusCode).toBe(200);

    await app.close();
  });
});
