import { NoopMetricsRecorder, PrometheusMetricsRecorder } from "@verixa/observability";
import { describe, expect, it } from "vitest";

import { createObservabilityComponents } from "./observability.js";

describe("Observability composition root wiring", () => {
  it("creates noop metrics and silent logger in test environment", () => {
    const components = createObservabilityComponents({
      environment: "test",
      serviceName: "test-verixa-api",
    });

    expect(components.logger).toBeDefined();
    expect(components.metricsRecorder).toBeInstanceOf(NoopMetricsRecorder);
    expect(components.healthCheckRegistry).toBeDefined();
  });

  it("creates prometheus recorder in development or production environment", () => {
    const components = createObservabilityComponents({
      environment: "production",
      serviceName: "prod-verixa-api",
    });

    expect(components.metricsRecorder).toBeInstanceOf(PrometheusMetricsRecorder);
    expect(components.logger).toBeDefined();
    expect(components.healthCheckRegistry).toBeDefined();
  });

  it("registers database and redis health checks when provided", () => {
    const fakePrisma = { $queryRaw: () => Promise.resolve() };
    const fakeRedis = { ping: () => Promise.resolve("PONG") };

    const components = createObservabilityComponents({
      environment: "test",
      prisma: fakePrisma,
      redis: fakeRedis,
    });

    const registered = components.healthCheckRegistry.getRegisteredNames();
    expect(registered).toContain("postgres");
    expect(registered).toContain("redis");
  });

  it("handles shutdown cleanly without error", async () => {
    const components = createObservabilityComponents({
      environment: "test",
    });

    await expect(components.shutdown()).resolves.not.toThrow();
  });
});
