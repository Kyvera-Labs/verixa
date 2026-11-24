import { describe, expect, it } from "vitest";

import { VolumeAnomalyDetector } from "./volume-anomaly-detector.js";

describe("VolumeAnomalyDetector", () => {
  const windowMs = 60_000;

  it("flags sudden multi-x spike over established baseline", () => {
    const detector = new VolumeAnomalyDetector({
      windowDurationMs: windowMs,
      baselineWindowCount: 5,
      thresholdMultiplier: 3.0,
      minBaselineThreshold: 5,
    });

    const user = "victim@example.com";
    const start = 1_000_000;

    // Establish steady baseline of ~10 requests per minute across 5 windows
    detector.seedHistory(user, [10, 10, 10, 10, 10], start);

    // Current window receives 45 requests (4.5x baseline, exceeding 3.0x multiplier)
    const currentWindowTime = start + 5 * windowMs;
    for (let i = 0; i < 45; i += 1) {
      detector.recordRequest(user, currentWindowTime + i * 100);
    }

    const flag = detector.check(user, currentWindowTime + 5000);
    expect(flag.flagged).toBe(true);
    expect(flag.type).toBe("volume_spike");
    expect(flag.details?.currentCount).toBe(45);
    expect(flag.details?.baselineAverage).toBe(10);
  });

  it("does not flag gradual organic growth within threshold multiplier", () => {
    const detector = new VolumeAnomalyDetector({
      windowDurationMs: windowMs,
      baselineWindowCount: 4,
      thresholdMultiplier: 2.5,
      minBaselineThreshold: 5,
    });

    const user = "legit@example.com";
    const start = 1_000_000;

    // Gradual progression: 10 -> 12 -> 15 -> 18
    detector.seedHistory(user, [10, 12, 15, 18], start);

    // Current window reaches 24 requests:
    // Baseline avg = (10+12+15+18)/4 = 13.75; 24 / 13.75 = ~1.75x < 2.5x threshold
    const currentWindowTime = start + 4 * windowMs;
    for (let i = 0; i < 24; i += 1) {
      detector.recordRequest(user, currentWindowTime + i * 100);
    }

    const flag = detector.check(user, currentWindowTime + 3000);
    expect(flag.flagged).toBe(false);
  });

  it("does not flag small changes below minBaselineThreshold", () => {
    const detector = new VolumeAnomalyDetector({
      windowDurationMs: windowMs,
      baselineWindowCount: 3,
      thresholdMultiplier: 3.0,
      minBaselineThreshold: 10,
    });

    const user = "quiet@example.com";
    const start = 1_000_000;

    // Baseline of 2 requests per minute
    detector.seedHistory(user, [2, 2, 2], start);

    // Current window receives 8 requests (4x relative to 2, but under minBaselineThreshold * multiplier)
    const currentWindowTime = start + 3 * windowMs;
    for (let i = 0; i < 8; i += 1) {
      detector.recordRequest(user, currentWindowTime + i * 100);
    }

    const flag = detector.check(user, currentWindowTime + 1000);
    expect(flag.flagged).toBe(false);
  });

  it("supports configurable baseline window size and resets cleanly", () => {
    const detector = new VolumeAnomalyDetector({
      windowDurationMs: windowMs,
      baselineWindowCount: 2, // only looks at past 2 windows
      thresholdMultiplier: 2.0,
      minBaselineThreshold: 5,
    });

    const user = "reset-user@example.com";
    const start = 1_000_000;

    detector.seedHistory(user, [100, 10], start); // recent average = 55
    const currentWindowTime = start + 2 * windowMs;
    for (let i = 0; i < 60; i += 1) {
      detector.recordRequest(user, currentWindowTime + i * 10);
    }

    // 60 / 55 = ~1.09x < 2.0x
    expect(detector.check(user, currentWindowTime).flagged).toBe(false);

    detector.reset(user);
    expect(detector.check(user, currentWindowTime).flagged).toBe(false);
  });
});
