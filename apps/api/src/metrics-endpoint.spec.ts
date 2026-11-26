import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";

describe("GET /metrics", () => {
  let app: ReturnType<typeof buildApp> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("is not served by default, because it exposes traffic and error patterns", async () => {
    app = buildApp({ rateLimit: false });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/metrics" });

    expect(res.statusCode).toBe(404);
  });

  it("serves Prometheus text when METRICS_ENABLED switches it on", async () => {
    app = buildApp({ rateLimit: false, metricsEndpoint: true });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/metrics" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
  });
});
