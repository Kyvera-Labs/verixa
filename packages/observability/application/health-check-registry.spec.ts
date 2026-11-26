import { describe, expect, it } from "vitest";

import {
  createPostgresHealthCheck,
  createRedisHealthCheck,
  HealthCheckRegistry,
} from "./health-check-registry.js";

describe("HealthCheckRegistry", () => {
  it("returns healthy when no checks are registered", async () => {
    const registry = new HealthCheckRegistry();
    const result = await registry.check();

    expect(result.status).toBe("healthy");
    expect(result.dependencies).toEqual({});
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.timestamp).toBeDefined();
  });

  it("returns healthy with up status and latencies when all dependencies succeed", async () => {
    const registry = new HealthCheckRegistry();

    registry.register({
      name: "postgres",
      check: async () => {
        // simulate fast DB ping
        await new Promise((r) => setTimeout(r, 10));
      },
    });

    registry.register({
      name: "redis",
      check: async () => {
        // simulate fast cache ping
        await new Promise((r) => setTimeout(r, 5));
      },
    });

    const result = await registry.check();

    expect(result.status).toBe("healthy");
    expect(result.dependencies.postgres?.status).toBe("up");
    expect(result.dependencies.postgres?.latencyMs).toBeGreaterThanOrEqual(5);
    expect(result.dependencies.redis?.status).toBe("up");
    expect(result.dependencies.redis?.latencyMs).toBeGreaterThanOrEqual(2);
  });

  it("returns unhealthy and 503-ready when a required dependency fails", async () => {
    const registry = new HealthCheckRegistry();

    registry.register({
      name: "postgres",
      check: () => Promise.resolve(),
    });

    registry.register({
      name: "redis",
      check: () => Promise.reject(new Error("ECONNREFUSED 127.0.0.1:6379")),
      required: true,
    });

    const result = await registry.check();

    expect(result.status).toBe("unhealthy");
    expect(result.dependencies.postgres?.status).toBe("up");
    expect(result.dependencies.redis?.status).toBe("down");
    expect(result.dependencies.redis?.error).toContain("ECONNREFUSED");
  });

  it("does not mark overall health unhealthy when an optional dependency fails", async () => {
    const registry = new HealthCheckRegistry();

    registry.register({
      name: "postgres",
      check: () => Promise.resolve(),
      required: true,
    });

    registry.register({
      name: "analytics",
      check: () => Promise.reject(new Error("Third party down")),
      required: false,
    });

    const result = await registry.check();

    expect(result.status).toBe("healthy");
    expect(result.dependencies.postgres?.status).toBe("up");
    expect(result.dependencies.analytics?.status).toBe("down");
  });

  it("bounds execution time when a dependency hangs and times out", async () => {
    const registry = new HealthCheckRegistry({ defaultTimeoutMs: 50 });

    registry.register({
      name: "slow-service",
      timeoutMs: 40,
      check: async () => {
        // hangs for 5 seconds
        await new Promise((r) => setTimeout(r, 5000));
      },
    });

    const startTime = performance.now();
    const result = await registry.check();
    const duration = performance.now() - startTime;

    expect(duration).toBeLessThan(300); // Bounded, doesn't wait 5000ms
    expect(result.status).toBe("unhealthy");
    expect(result.dependencies["slow-service"]?.status).toBe("down");
    expect(result.dependencies["slow-service"]?.error).toContain("timed out after 40ms");
  });

  it("supports unregistering checks", () => {
    const registry = new HealthCheckRegistry();

    registry.register({
      name: "temp",
      check: () => Promise.resolve(),
    });
    expect(registry.getRegisteredNames()).toContain("temp");

    const unregistered = registry.unregister("temp");
    expect(unregistered).toBe(true);
    expect(registry.getRegisteredNames()).not.toContain("temp");
  });

  it("creates standard postgres and redis check registrations", async () => {
    let rawQueryCalled = false;
    const fakePrisma = {
      $queryRaw: () => {
        rawQueryCalled = true;
        return Promise.resolve();
      },
    };

    let pingCalled = false;
    const fakeRedis = {
      ping: () => {
        pingCalled = true;
        return Promise.resolve("PONG");
      },
    };

    const pgCheck = createPostgresHealthCheck(fakePrisma);
    expect(pgCheck.name).toBe("postgres");
    await pgCheck.check();
    expect(rawQueryCalled).toBe(true);

    const redisCheck = createRedisHealthCheck(fakeRedis);
    expect(redisCheck.name).toBe("redis");
    await redisCheck.check();
    expect(pingCalled).toBe(true);
  });

  it("fails redis check if ping response is not PONG", async () => {
    const brokenRedis = {
      ping: () => Promise.resolve("LOADING Redis is loading the dataset in memory"),
    };
    const redisCheck = createRedisHealthCheck(brokenRedis);

    await expect(redisCheck.check()).rejects.toThrow("Unexpected Redis ping response");
  });
});
