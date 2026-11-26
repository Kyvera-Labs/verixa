import { HealthCheckRegistry } from "@verixa/observability";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { registerHealthRoutes } from "./health.js";

interface HealthCheckReport {
  status: string;
  timestamp: string;
  durationMs: number;
  dependencies: Record<string, { status: string; durationMs: number; error?: string }>;
}

describe("Health routes (/health/live, /health, /health/ready)", () => {
  it("GET /health/live returns 200 OK without executing dependency checks", async () => {
    const app = Fastify();
    registerHealthRoutes(app);
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/health/live" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });

    await app.close();
  });

  it("GET /health returns 200 OK for backward compatibility", async () => {
    const app = Fastify();
    registerHealthRoutes(app);
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });

    await app.close();
  });

  it("GET /health/ready returns 200 OK when all dependencies are healthy", async () => {
    const app = Fastify();
    const registry = new HealthCheckRegistry();
    registry.register({
      name: "postgres",
      check: async () => {},
      required: true,
    });
    registry.register({
      name: "redis",
      check: () => Promise.resolve(),
      required: true,
    });

    registerHealthRoutes(app, { healthCheckRegistry: registry });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(200);
    const body = res.json<HealthCheckReport>();
    expect(body.status).toBe("healthy");
    expect(body.dependencies["postgres"]?.status).toBe("up");
    expect(body.dependencies["redis"]?.status).toBe("up");

    await app.close();
  });

  it("GET /health/ready returns 503 Service Unavailable when a required dependency fails", async () => {
    const app = Fastify();
    const registry = new HealthCheckRegistry();
    registry.register({
      name: "postgres",
      check: () => Promise.resolve(),
      required: true,
    });
    registry.register({
      name: "redis",
      check: () => Promise.reject(new Error("Redis cluster node down")),
      required: true,
    });

    registerHealthRoutes(app, { healthCheckRegistry: registry });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(503);
    const body = res.json<HealthCheckReport>();
    expect(body.status).toBe("unhealthy");
    expect(body.dependencies["postgres"]?.status).toBe("up");
    expect(body.dependencies["redis"]?.status).toBe("down");
    expect(body.dependencies["redis"]?.error).toContain("Redis cluster node down");

    await app.close();
  });

  it("GET /health/ready returns 503 within bounded timeout when a dependency hangs", async () => {
    const app = Fastify();
    const registry = new HealthCheckRegistry();
    registry.register({
      name: "hanging-db",
      timeoutMs: 50,
      check: async () => {
        await new Promise((r) => setTimeout(r, 5000));
      },
      required: true,
    });

    registerHealthRoutes(app, { healthCheckRegistry: registry });
    await app.ready();

    const start = performance.now();
    const res = await app.inject({ method: "GET", url: "/health/ready" });
    const duration = performance.now() - start;

    expect(duration).toBeLessThan(400); // Does not hang the probe
    expect(res.statusCode).toBe(503);
    const body = res.json<HealthCheckReport>();
    expect(body.status).toBe("unhealthy");
    expect(body.dependencies["hanging-db"]?.status).toBe("down");
    expect(body.dependencies["hanging-db"]?.error).toContain("timed out after 50ms");

    await app.close();
  });
});
