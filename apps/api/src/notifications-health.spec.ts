import supertest from "supertest";
import { afterAll, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import type { Container } from "./composition-root.js";

describe("GET /health/notifications", () => {
  const container = {
    identity: {},
    authorization: {},
    audit: {},
    notifications: {
      worker: {
        start: () => undefined,
        stop: () => Promise.resolve(),
        health: () => ({ running: false, lastError: "connect ECONNREFUSED smtp.internal:587" }),
      },
    },
  } as unknown as Container;
  const app = buildApp({ container });

  afterAll(async () => {
    await app.close();
  });

  it("reports whether the worker is running", async () => {
    await app.ready();
    const res = await supertest(app.server).get("/health/notifications");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ running: false });
  });

  it("never exposes the worker's last error on the public endpoint", async () => {
    await app.ready();
    const res = await supertest(app.server).get("/health/notifications");

    expect(JSON.stringify(res.body)).not.toContain("smtp.internal");
  });
});
