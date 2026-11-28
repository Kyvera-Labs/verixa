/**
 * Backend-agnostic metrics port, bound at the composition root (`apps/api/src/server.ts`): a
 * capturing no-op adapter in tests, Prometheus or OpenTelemetry in production.
 *
 * 1. Names follow Prometheus and OpenTelemetry rules: `[a-z][a-z0-9_]*`, counters end in `_total`,
 *    histograms carry a unit suffix such as `_seconds` or `_bytes`.
 * 2. Labels must be low-cardinality (`method`, `route`, `status_class`). Never use user IDs,
 *    tokens, emails or raw paths; adapters must reject or sanitize unbounded values.
 */

export type MetricLabelValue = string | number | boolean;

/**
 * Low-cardinality dimensional labels associated with a metric observation.
 */
export type MetricLabels = Readonly<Record<string, MetricLabelValue>>;

/**
 * Port contract for recording operational metrics.
 */
export interface MetricsRecorder {
  /**
   * Increments a monotonic counter by a positive value (defaults to 1).
   *
   * Counters represent cumulative metrics that only increase or reset to zero on restart.
   *
   * @param name The metric name (e.g. 'verixa_http_requests_total')
   * @param value The amount to increment by (must be >= 0; defaults to 1)
   * @param labels Low-cardinality dimensional labels
   */
  incrementCounter(name: string, value?: number, labels?: MetricLabels): void;
  incrementCounter(name: string, labels?: MetricLabels): void;
  incrementCounter(
    name: string,
    valueOrLabels?: number | MetricLabels,
    labelsOrValue?: MetricLabels | number,
  ): void;

  /**
   * Records a value observation into a histogram distribution (e.g., request latency in seconds).
   *
   * Histograms track statistical distributions across configurable bucket boundaries.
   *
   * @param name The metric name (e.g. 'verixa_http_request_duration_seconds')
   * @param value The observed value (e.g. duration in seconds)
   * @param labels Low-cardinality dimensional labels
   */
  recordHistogram(name: string, value: number, labels?: MetricLabels): void;

  /**
   * Sets a gauge's current value, which can rise or fall (in-flight requests, active connections,
   * cache size).
   *
   * @param name The metric name (for example `verixa_http_in_flight_requests`)
   * @param value The current gauge value
   * @param labels Low-cardinality labels
   */
  setGauge(name: string, value: number, labels?: MetricLabels): void;

  /**
   * Increments a gauge by a given amount (defaults to 1).
   */
  incrementGauge?(name: string, value?: number, labels?: MetricLabels): void;

  /**
   * Decrements a gauge by a given amount (defaults to 1).
   */
  decrementGauge?(name: string, value?: number, labels?: MetricLabels): void;
}
