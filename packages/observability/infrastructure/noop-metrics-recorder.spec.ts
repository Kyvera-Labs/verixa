import { describe, expect, it } from "vitest";

import { NoopMetricsRecorder } from "./noop-metrics-recorder.js";

describe("NoopMetricsRecorder", () => {
  it("captures counter calls in memory", () => {
    const recorder = new NoopMetricsRecorder();

    recorder.incrementCounter("verixa_requests_total");
    recorder.incrementCounter("verixa_requests_total", 3, { method: "POST" });

    expect(recorder.calls).toHaveLength(2);
    expect(recorder.recordedCounters).toHaveLength(2);
    expect(recorder.getCounter("verixa_requests_total")).toBe(4);
    expect(recorder.getCounter("verixa_requests_total", { method: "POST" })).toBe(3);
    expect(recorder.hasRecordedCounter("verixa_requests_total")).toBe(true);
    expect(recorder.hasRecordedCounter("non_existent")).toBe(false);
  });

  it("captures histogram observations in memory", () => {
    const recorder = new NoopMetricsRecorder();

    recorder.recordHistogram("verixa_latency_seconds", 0.05, { route: "/login" });
    recorder.recordHistogram("verixa_latency_seconds", 0.12, { route: "/login" });
    recorder.recordHistogram("verixa_latency_seconds", 0.02, { route: "/health" });

    expect(recorder.recordedHistograms).toHaveLength(3);
    expect(
      recorder.getHistogramObservations("verixa_latency_seconds", { route: "/login" }),
    ).toEqual([0.05, 0.12]);
  });

  it("captures gauge values and updates them", () => {
    const recorder = new NoopMetricsRecorder();

    recorder.setGauge("verixa_in_flight", 5);
    expect(recorder.getGauge("verixa_in_flight")).toBe(5);

    recorder.incrementGauge("verixa_in_flight", 3);
    expect(recorder.getGauge("verixa_in_flight")).toBe(8);

    recorder.decrementGauge("verixa_in_flight", 2);
    expect(recorder.getGauge("verixa_in_flight")).toBe(6);
  });

  it("resets captured calls cleanly", () => {
    const recorder = new NoopMetricsRecorder();

    recorder.incrementCounter("c1");
    recorder.setGauge("g1", 10);
    expect(recorder.calls.length).toBeGreaterThan(0);

    recorder.reset();
    expect(recorder.calls).toHaveLength(0);
    expect(recorder.getCounter("c1")).toBe(0);
    expect(recorder.getGauge("g1")).toBeUndefined();
  });

  it("respects captureCalls: false option", () => {
    const recorder = new NoopMetricsRecorder({ captureCalls: false });

    recorder.incrementCounter("c1");
    recorder.recordHistogram("h1", 1.2);
    recorder.setGauge("g1", 10);

    expect(recorder.calls).toHaveLength(0);
    expect(recorder.recordedCounters).toHaveLength(0);
  });
});
