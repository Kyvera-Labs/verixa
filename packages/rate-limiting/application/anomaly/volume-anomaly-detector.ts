import type { AnomalyFlag } from "./impossible-travel-detector.js";

export interface VolumeAnomalyDetectorOptions {
  /**
   * Duration of each discrete sampling window in milliseconds.
   * Default is 60,000 ms (1 minute).
   */
  readonly windowDurationMs?: number | undefined;
  /**
   * Number of preceding historical windows used to compute the simple moving average (SMA).
   * Default is 5 windows.
   */
  readonly baselineWindowCount?: number | undefined;
  /**
   * Multiplier threshold above rolling baseline that triggers an anomaly flag.
   * For example, 3.0 means a request rate exceeding 300% of the subject's baseline rate is flagged.
   * Default is 3.0.
   */
  readonly thresholdMultiplier?: number | undefined;
  /**
   * Minimum average baseline volume required before anomaly flags can trigger.
   * Prevents cold-start false positives for subjects with very low activity (e.g., jumping from 1 to 4 requests).
   * Default is 5 requests per window.
   */
  readonly minBaselineThreshold?: number | undefined;
}

interface WindowBucket {
  windowStart: number;
  count: number;
}

/**
 * VolumeAnomalyDetector
 *
 * Detects volumetric abuse and scraping patterns by comparing an identity's (IP or account)
 * current request rate against its own rolling baseline (simple moving average).
 *
 * Catches slow-drip, ramping, or distributed volumetric attacks that evade static fixed-window limits
 * by flagging sudden multi-fold spikes relative to the subject's established baseline.
 */
export class VolumeAnomalyDetector {
  private readonly windowDurationMs: number;
  private readonly baselineWindowCount: number;
  private readonly thresholdMultiplier: number;
  private readonly minBaselineThreshold: number;
  private readonly history = new Map<string, WindowBucket[]>();

  constructor(options: VolumeAnomalyDetectorOptions = {}) {
    this.windowDurationMs = Math.max(1000, options.windowDurationMs ?? 60_000);
    this.baselineWindowCount = Math.max(1, options.baselineWindowCount ?? 5);
    this.thresholdMultiplier = Math.max(1.1, options.thresholdMultiplier ?? 3.0);
    this.minBaselineThreshold = Math.max(1, options.minBaselineThreshold ?? 5);
  }

  /**
   * Records a request event for the given identifier at timestamp `now`.
   */
  recordRequest(identifier: string, now: number = Date.now()): void {
    const key = identifier.trim().toLowerCase();
    const currentWindowStart = Math.floor(now / this.windowDurationMs) * this.windowDurationMs;

    let buckets = this.history.get(key);
    if (!buckets) {
      buckets = [];
      this.history.set(key, buckets);
    }

    const latest = buckets.at(-1);
    if (latest && latest.windowStart === currentWindowStart) {
      latest.count += 1;
    } else {
      buckets.push({ windowStart: currentWindowStart, count: 1 });
      // Keep only enough windows for baseline plus current window
      const maxRetained = this.baselineWindowCount + 2;
      if (buckets.length > maxRetained) {
        buckets.splice(0, buckets.length - maxRetained);
      }
    }
  }

  /**
   * Ingests a pre-calculated slice of window counts for testing or batch metrics.
   */
  seedHistory(identifier: string, windowCounts: number[], startTimestamp: number): void {
    const key = identifier.trim().toLowerCase();
    const buckets: WindowBucket[] = windowCounts.map((count, index) => ({
      windowStart: startTimestamp + index * this.windowDurationMs,
      count,
    }));
    this.history.set(key, buckets);
  }

  /**
   * Evaluates whether the subject's current request volume represents an anomalous deviation
   * from its historical rolling baseline.
   */
  check(identifier: string, now: number = Date.now()): AnomalyFlag {
    const key = identifier.trim().toLowerCase();
    const currentWindowStart = Math.floor(now / this.windowDurationMs) * this.windowDurationMs;
    const buckets = this.history.get(key);

    if (!buckets || buckets.length === 0) {
      return { flagged: false };
    }

    // Historical windows strictly preceding current window
    const historicalWindows = buckets.filter((b) => b.windowStart < currentWindowStart);
    if (historicalWindows.length === 0) {
      return { flagged: false };
    }

    // Recent baseline slice up to baselineWindowCount
    const baselineSlice = historicalWindows.slice(-this.baselineWindowCount);
    const totalBaselineCount = baselineSlice.reduce((sum, b) => sum + b.count, 0);
    const baselineAverage = totalBaselineCount / baselineSlice.length;

    // Current window count
    const currentBucket = buckets.find((b) => b.windowStart === currentWindowStart);
    const currentCount = currentBucket ? currentBucket.count : 0;

    // Effective baseline floor to prevent low-n false alarms
    const effectiveBaseline = Math.max(baselineAverage, this.minBaselineThreshold);
    const thresholdCount = effectiveBaseline * this.thresholdMultiplier;

    if (currentCount > thresholdCount) {
      const multiplier = Math.round((currentCount / effectiveBaseline) * 10) / 10;
      const score = Math.min(
        1.0,
        Math.round((multiplier / (this.thresholdMultiplier * 2)) * 100) / 100,
      );

      return {
        flagged: true,
        type: "volume_spike",
        reason: `Request volume (${currentCount}) exceeded baseline (${Math.round(baselineAverage * 10) / 10}) by ${multiplier}x`,
        score,
        details: {
          identifier,
          currentCount,
          baselineAverage,
          thresholdMultiplier: this.thresholdMultiplier,
          windowDurationMs: this.windowDurationMs,
          baselineWindowsSampled: baselineSlice.length,
        },
      };
    }

    return { flagged: false };
  }

  /**
   * Clears historical window state for an identifier.
   */
  reset(identifier: string): void {
    const key = identifier.trim().toLowerCase();
    this.history.delete(key);
  }
}
