import { Registry } from "prom-client";
import { beforeEach, describe, expect, it } from "vitest";

import {
  CardinalityGuardError,
  InvalidMetricNameError,
  PrometheusMetricsRecorder,
  getSharedRegistry,
  resetSharedRegistry,
} from "./prometheus-metrics-recorder.js";

describe("PrometheusMetricsRecorder", () => {
  let customRegistry: Registry;
  let recorder: PrometheusMetricsRecorder;

  beforeEach(() => {
    resetSharedRegistry();
    customRegistry = new Registry();
    recorder = new PrometheusMetricsRecorder({
      registry: customRegistry,
      maxCardinalityPerMetric: 5,
    });
  });

  describe("singleton registry", () => {
    it("shares a singleton registry across instances by default", () => {
      const recorderA = new PrometheusMetricsRecorder();
      const recorderB = new PrometheusMetricsRecorder();

      expect(recorderA.registry).toBe(getSharedRegistry());
      expect(recorderB.registry).toBe(getSharedRegistry());
    });
  });

  describe("metrics exposition", () => {
    it("exposes registered metrics in Prometheus text format", async () => {
      recorder.incrementCounter("verixa_test_requests_total", 2, {
        method: "GET",
        status_class: "2xx",
      });
      recorder.recordHistogram("verixa_test_duration_seconds", 0.05, {
        method: "GET",
      });
      recorder.setGauge("verixa_test_in_flight", 3);

      const exposition = await recorder.metrics();

      expect(exposition).toContain("# TYPE verixa_test_requests_total counter");
      expect(exposition).toContain('verixa_test_requests_total{method="GET",status_class="2xx"} 2');
      expect(exposition).toContain("# TYPE verixa_test_duration_seconds histogram");
      expect(exposition).toContain('verixa_test_duration_seconds_bucket{le="0.05",method="GET"} 1');
      expect(exposition).toContain("# TYPE verixa_test_in_flight gauge");
      expect(exposition).toContain("verixa_test_in_flight 3");
      expect(recorder.contentType).toContain("text/plain");
    });
  });

  describe("cardinality guards", () => {
    it("rejects forbidden label keys like userId, token, and email", () => {
      const forbiddenKeys = [
        "userId",
        "user_id",
        "email",
        "token",
        "sessionId",
        "session_id",
        "ip",
        "client_ip",
        "request_id",
        "trace_id",
      ];

      for (const key of forbiddenKeys) {
        expect(() => {
          recorder.incrementCounter("verixa_bad_labels_total", {
            [key]: "some-value",
          });
        }).toThrow(CardinalityGuardError);
      }
    });

    it("rejects label values that are UUIDs", () => {
      expect(() => {
        recorder.incrementCounter("verixa_events_total", {
          entity: "123e4567-e89b-12d3-a456-426614174000",
        });
      }).toThrow(CardinalityGuardError);
    });

    it("rejects label values that are email addresses", () => {
      expect(() => {
        recorder.incrementCounter("verixa_events_total", {
          target: "admin@verixa.example.org",
        });
      }).toThrow(CardinalityGuardError);
    });

    it("rejects excessively long or token-like label values", () => {
      const longValue = "a".repeat(150);
      expect(() => {
        recorder.incrementCounter("verixa_events_total", {
          tag: longValue,
        });
      }).toThrow(CardinalityGuardError);
    });

    it("rejects metric when maximum cardinality limit of distinct label sets is exceeded", () => {
      for (let i = 0; i < 5; i++) {
        recorder.incrementCounter("verixa_bounded_metric_total", {
          partition: `p${i}`,
        });
      }

      expect(() => {
        recorder.incrementCounter("verixa_bounded_metric_total", {
          partition: "p5",
        });
      }).toThrow(CardinalityGuardError);
    });
  });

  describe("metric name validation", () => {
    it("rejects invalid Prometheus metric names", () => {
      const invalidNames = ["bad-metric", "metric with spaces", "123numeric_start", "bad!char"];

      for (const name of invalidNames) {
        expect(() => {
          recorder.incrementCounter(name);
        }).toThrow(InvalidMetricNameError);
      }
    });
  });
});
