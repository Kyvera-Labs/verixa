/**
 * Metrics port abstraction (Phase 18 Observability, Issue 347 / #459).
 *
 * Provides a backend-agnostic seam for emitting numeric telemetry across
 * domain, application, and infrastructure layers without coupling call sites
 * to any concrete vendor library (e.g., `prom-client`, DataDog, AWS CloudWatch).
 *
 * ## Architectural Seam
 *
 * Application use cases and domain services measure operational signals
 * (counter increments, latency observations, gauge levels) through this port.
 * The concrete backend is bound at the composition root (`apps/api/src/server.ts`),
 * allowing unit tests to run with a memory-capturing no-op adapter and production
 * environments to route measurements to Prometheus or OpenTelemetry metrics.
 *
 * ## Method Contracts & Naming Conventions
 *
 * 1. Metric names must follow Prometheus / OpenTelemetry naming rules:
 *    - Lowercase alphanumeric characters and underscores: `[a-z][a-z0-9_]*`
 *    - Monotonic counters should end in `_total` (e.g. `verixa_http_requests_total`).
 *    - Histograms should include measurement unit suffix (e.g. `_seconds`, `_bytes`).
 * 2. Label cardinality:
 *    - Labels must represent low-cardinality discrete dimensions (e.g., `method`, `route`, `status_class`).
 *    - Call sites must NEVER include high-cardinality values such as user IDs, tokens, emails,
 *      or raw interpolated paths (e.g., `/users/123e4567-e89b...`). Adapters are required
 *      to reject or sanitize unbounded label values.
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
   * Sets the current value of a gauge representing an instantaneous level.
   *
   * Gauges can increase, decrease, or remain stationary over time (e.g., in-flight requests,
   * active connections, cache item count).
   *
   * @param name The metric name (e.g. 'verixa_http_in_flight_requests')
   * @param value The current gauge value
   * @param labels Low-cardinality dimensional labels
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
