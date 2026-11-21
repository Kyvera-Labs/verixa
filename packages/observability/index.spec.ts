import { describe, expect, it } from "vitest";

import * as observability from "./index.js";

describe("@verixa/observability exports", () => {
  it("exports metrics port and adapters", () => {
    expect(observability.NoopMetricsRecorder).toBeDefined();
    expect(observability.PrometheusMetricsRecorder).toBeDefined();
    expect(observability.CardinalityGuardError).toBeDefined();
    expect(observability.InvalidMetricNameError).toBeDefined();
    expect(observability.DEFAULT_LATENCY_BUCKETS).toBeDefined();
    expect(observability.getSharedRegistry).toBeDefined();
    expect(observability.resetSharedRegistry).toBeDefined();
  });

  it("exports OpenTelemetry bootstrap utilities and resource constants", () => {
    expect(observability.OTEL_RESOURCE_ATTRIBUTES).toBeDefined();
    expect(observability.initOtelBootstrap).toBeDefined();
    expect(observability.isOtelActive).toBeDefined();
    expect(observability.shutdownOtel).toBeDefined();
    expect(observability.assertBootstrapLoadOrder).toBeDefined();
    expect(observability.resolveResourceAttributes).toBeDefined();
    expect(observability.getActiveResourceAttributes).toBeDefined();
    expect(observability.getActiveMemorySpanExporter).toBeDefined();
  });

  it("exports RequestContext foundation and correlation functions", () => {
    expect(observability.requestContextStorage).toBeDefined();
    expect(observability.runWithRequestContext).toBeDefined();
    expect(observability.getRequestContext).toBeDefined();
    expect(observability.getCorrelationId).toBeDefined();
    expect(observability.getTraceId).toBeDefined();
    expect(observability.getActiveTraceId).toBeDefined();
    expect(observability.bindRequestContext).toBeDefined();
    expect(observability.clearRequestContext).toBeDefined();
  });

  it("exports contextual logger and redaction constants", () => {
    expect(observability.createContextualLogger).toBeDefined();
    expect(observability.DEFAULT_REDACT_PATHS).toBeDefined();
  });

  it("exports HealthCheckRegistry and standard check factories", () => {
    expect(observability.HealthCheckRegistry).toBeDefined();
    expect(observability.createPostgresHealthCheck).toBeDefined();
    expect(observability.createRedisHealthCheck).toBeDefined();
  });
});
