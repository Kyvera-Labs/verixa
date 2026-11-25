import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startE2eEnvironment, type E2eEnvironment } from "./setup.js";

describe("API process smoke test", () => {
  let environment: E2eEnvironment;

  beforeAll(async () => {
    environment = await startE2eEnvironment();
  });

  afterAll(async () => {
    await environment?.stop();
  });

  it("starts against disposable Postgres and Redis and serves HTTP health/version", async () => {
    const health = await fetch(`${environment.app.baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });

    const version = await fetch(`${environment.app.baseUrl}/version`);
    expect(version.status).toBe(200);
    expect(await version.json()).toEqual({ version: "e2e-smoke" });
  });
});
