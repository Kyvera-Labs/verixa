import { defineContractTests } from "@verixa/testing-kit";
import { Registry } from "prom-client";
import { describe, expect, it } from "vitest";

import type { MetricsRecorder } from "../application/ports/metrics.js";

import { NoopMetricsRecorder } from "./noop-metrics-recorder.js";
import { PrometheusMetricsRecorder } from "./prometheus-metrics-recorder.js";

/**
 * Shared contract test suite verifying that both NoopMetricsRecorder and
 * PrometheusMetricsRecorder faithfully fulfill the MetricsRecorder port contract.
 */
defineContractTests<MetricsRecorder>(
  [
    {
      name: "NoopMetricsRecorder",
      factory: () => new NoopMetricsRecorder(),
    },
    {
      name: "PrometheusMetricsRecorder",
      factory: () =>
        new PrometheusMetricsRecorder({
          registry: new Registry(),
          maxCardinalityPerMetric: 50,
        }),
    },
  ],
  (getAdapter) => {
    describe("counter operations", () => {
      it("increments a counter without labels by default 1", () => {
        const recorder = getAdapter();
        expect(() => {
          recorder.incrementCounter("verixa_test_counter_total");
        }).not.toThrow();
      });

      it("increments a counter by a specific numeric value", () => {
        const recorder = getAdapter();
        expect(() => {
          recorder.incrementCounter("verixa_test_counter_total", 5);
        }).not.toThrow();
      });

      it("increments a counter with low-cardinality labels", () => {
        const recorder = getAdapter();
        expect(() => {
          recorder.incrementCounter("verixa_test_requests_total", {
            method: "GET",
            status_class: "2xx",
          });
        }).not.toThrow();
      });

      it("increments a counter with both value and labels in either argument order", () => {
        const recorder = getAdapter();
        expect(() => {
          recorder.incrementCounter("verixa_test_order_a_total", 3, {
            route: "/health",
          });
          recorder.incrementCounter("verixa_test_order_b_total", { route: "/ready" }, 2);
        }).not.toThrow();
      });
    });

    describe("histogram operations", () => {
      it("records observations without throwing", () => {
        const recorder = getAdapter();
        expect(() => {
          recorder.recordHistogram("verixa_test_duration_seconds", 0.045);
        }).not.toThrow();
      });

      it("records observations with low-cardinality dimensional labels", () => {
        const recorder = getAdapter();
        expect(() => {
          recorder.recordHistogram("verixa_test_duration_seconds", 0.12, {
            route: "/auth/login",
            method: "POST",
            status_class: "2xx",
          });
        }).not.toThrow();
      });
    });

    describe("gauge operations", () => {
      it("sets gauge levels without throwing", () => {
        const recorder = getAdapter();
        expect(() => {
          recorder.setGauge("verixa_test_in_flight", 42);
        }).not.toThrow();
      });

      it("sets gauge levels with dimensional labels", () => {
        const recorder = getAdapter();
        expect(() => {
          recorder.setGauge("verixa_test_in_flight", 5, {
            method: "POST",
          });
        }).not.toThrow();
      });

      it("supports incremental and decremental adjustments", () => {
        const recorder = getAdapter();
        if (recorder.incrementGauge && recorder.decrementGauge) {
          expect(() => {
            recorder.incrementGauge!("verixa_test_pool_size", 2);
            recorder.decrementGauge!("verixa_test_pool_size", 1);
          }).not.toThrow();
        }
      });
    });
  },
);
