import type { MetricLabels, MetricsRecorder } from "../application/ports/metrics.js";

/**
 * A recorded metric invocation captured for test assertions.
 */
export interface RecordedMetricCall {
  readonly type: "counter" | "histogram" | "gauge";
  readonly name: string;
  readonly value: number;
  readonly labels?: MetricLabels | undefined;
  readonly timestamp: number;
}

export interface NoopMetricsRecorderOptions {
  /**
   * Whether to capture recorded calls in memory for test assertions.
   * Defaults to `true` to facilitate unit testing use cases.
   */
  readonly captureCalls?: boolean;
}

/**
 * No-op implementation of {@link MetricsRecorder} suitable for isolated unit tests
 * and environments where telemetry collection is turned off.
 *
 * Captures all metric operations in memory by default so unit tests can assert
 * that domain use cases or middleware emitted the expected metrics with the right
 * dimensional labels.
 */
export class NoopMetricsRecorder implements MetricsRecorder {
  private readonly captureCalls: boolean;
  private readonly _calls: RecordedMetricCall[] = [];

  constructor(options: NoopMetricsRecorderOptions = {}) {
    this.captureCalls = options.captureCalls ?? true;
  }

  /**
   * All recorded calls in chronological order.
   */
  get calls(): readonly RecordedMetricCall[] {
    return this._calls;
  }

  /**
   * Returns all recorded counter increments.
   */
  get recordedCounters(): readonly RecordedMetricCall[] {
    return this._calls.filter((c) => c.type === "counter");
  }

  /**
   * Returns all recorded histogram observations.
   */
  get recordedHistograms(): readonly RecordedMetricCall[] {
    return this._calls.filter((c) => c.type === "histogram");
  }

  /**
   * Returns all recorded gauge adjustments.
   */
  get recordedGauges(): readonly RecordedMetricCall[] {
    return this._calls.filter((c) => c.type === "gauge");
  }

  incrementCounter(
    name: string,
    valueOrLabels?: number | MetricLabels,
    labelsOrValue?: MetricLabels | number,
  ): void {
    const { value, labels } = this.normalizeCounterArgs(valueOrLabels, labelsOrValue);
    if (!this.captureCalls) return;

    this._calls.push({
      type: "counter",
      name,
      value,
      labels,
      timestamp: Date.now(),
    });
  }

  recordHistogram(name: string, value: number, labels?: MetricLabels): void {
    if (!this.captureCalls) return;

    this._calls.push({
      type: "histogram",
      name,
      value,
      labels,
      timestamp: Date.now(),
    });
  }

  setGauge(name: string, value: number, labels?: MetricLabels): void {
    if (!this.captureCalls) return;

    this._calls.push({
      type: "gauge",
      name,
      value,
      labels,
      timestamp: Date.now(),
    });
  }

  incrementGauge(name: string, value = 1, labels?: MetricLabels): void {
    if (!this.captureCalls) return;

    const current = this.getGauge(name, labels) ?? 0;
    this.setGauge(name, current + value, labels);
  }

  decrementGauge(name: string, value = 1, labels?: MetricLabels): void {
    if (!this.captureCalls) return;

    const current = this.getGauge(name, labels) ?? 0;
    this.setGauge(name, current - value, labels);
  }

  /**
   * Returns the aggregated counter value for a specific metric name and optional matching labels.
   */
  getCounter(name: string, labels?: MetricLabels): number {
    return this._calls
      .filter((c) => c.type === "counter" && c.name === name && this.labelsMatch(c.labels, labels))
      .reduce((sum, c) => sum + c.value, 0);
  }

  /**
   * Returns the latest gauge value for a metric name and optional matching labels.
   */
  getGauge(name: string, labels?: MetricLabels): number | undefined {
    const matching = this._calls.filter(
      (c) => c.type === "gauge" && c.name === name && this.labelsMatch(c.labels, labels),
    );
    if (matching.length === 0) return undefined;
    const last = matching[matching.length - 1];
    return last ? last.value : undefined;
  }

  /**
   * Returns all observed values for a histogram metric.
   */
  getHistogramObservations(name: string, labels?: MetricLabels): number[] {
    return this._calls
      .filter(
        (c) => c.type === "histogram" && c.name === name && this.labelsMatch(c.labels, labels),
      )
      .map((c) => c.value);
  }

  /**
   * Returns true if a counter with the specified name (and optional labels) was incremented.
   */
  hasRecordedCounter(name: string, labels?: MetricLabels): boolean {
    return this.getCounter(name, labels) > 0;
  }

  /**
   * Clears all captured metric records.
   */
  reset(): void {
    this._calls.length = 0;
  }

  clear(): void {
    this.reset();
  }

  private normalizeCounterArgs(
    valueOrLabels?: number | MetricLabels,
    labelsOrValue?: MetricLabels | number,
  ): { value: number; labels?: MetricLabels | undefined } {
    let value = 1;
    let labels: MetricLabels | undefined;

    if (typeof valueOrLabels === "number") {
      value = valueOrLabels;
      if (typeof labelsOrValue === "object" && labelsOrValue !== null) {
        labels = labelsOrValue;
      }
    } else if (typeof valueOrLabels === "object" && valueOrLabels !== null) {
      labels = valueOrLabels;
      if (typeof labelsOrValue === "number") {
        value = labelsOrValue;
      }
    }

    return { value, labels };
  }

  private labelsMatch(actual?: MetricLabels, expected?: MetricLabels): boolean {
    if (!expected) return true;
    if (!actual) return Object.keys(expected).length === 0;

    const actualMap = new Map<string, unknown>(Object.entries(actual));
    for (const [key, val] of Object.entries(expected)) {
      if (actualMap.get(key) !== val) return false;
    }
    return true;
  }
}
