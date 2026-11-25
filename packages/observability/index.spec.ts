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

  it("exports the OpenTelemetry bootstrap kept from main", () => {
    expect(typeof observability.bootstrapOtel).toBe("function");
    expect(typeof observability.otelConfigFromAppConfig).toBe("function");
  });
});
