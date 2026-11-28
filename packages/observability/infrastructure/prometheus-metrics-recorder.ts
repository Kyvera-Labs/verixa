import { Counter, Gauge, Histogram, Registry, type LabelValues } from "prom-client";

import type { MetricLabels, MetricsRecorder } from "../application/ports/metrics.js";

/**
 * Thrown when a metric label key or value violates bounded cardinality requirements.
 */
export class CardinalityGuardError extends Error {
  readonly code = "UNBOUNDED_CARDINALITY";

  constructor(message: string) {
    super(message);
    this.name = "CardinalityGuardError";
  }
}

/**
 * Thrown when a metric name violates Prometheus metric naming conventions.
 */
export class InvalidMetricNameError extends Error {
  readonly code = "INVALID_METRIC_NAME";

  constructor(message: string) {
    super(message);
    this.name = "InvalidMetricNameError";
  }
}

/**
 * Standard HTTP latency buckets in seconds according to SRE golden signals:
 * 5ms, 10ms, 25ms, 50ms, 100ms, 250ms, 500ms, 1s, 2.5s, 5s, 10s.
 */
export const DEFAULT_LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/**
 * Label names known to introduce unbounded cardinality into timeseries databases.
 */
const FORBIDDEN_LABEL_NAMES = new Set([
  "userid",
  "user_id",
  "accountid",
  "account_id",
  "actorid",
  "actor_id",
  "email",
  "sub",
  "sessionid",
  "session_id",
  "token",
  "authtoken",
  "auth_token",
  "authorization",
  "ip",
  "ip_address",
  "remote_ip",
  "client_ip",
  "requestid",
  "request_id",
  "correlationid",
  "correlation_id",
  "traceid",
  "trace_id",
  "spanid",
  "span_id",
]);

/** Pattern matching UUID identifiers (v1-v5). */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Pattern matching email addresses. */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Pattern matching JWT format (header.payload.signature). */
const JWT_REGEX = /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}$/;

/** Prometheus metric name regex: [a-zA-Z_:][a-zA-Z0-9_:]* */
const METRIC_NAME_REGEX = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

let sharedRegistryInstance: Registry | null = null;

/**
 * Returns the singleton shared Prometheus registry used across the application.
 */
export function getSharedRegistry(): Registry {
  if (!sharedRegistryInstance) {
    sharedRegistryInstance = new Registry();
  }
  return sharedRegistryInstance;
}

/**
 * Resets the shared Prometheus registry (useful in test lifecycle teardowns).
 */
export function resetSharedRegistry(): void {
  if (sharedRegistryInstance) {
    sharedRegistryInstance.clear();
  }
  sharedRegistryInstance = null;
}

export interface PrometheusMetricsRecorderOptions {
  /** Custom Registry instance; defaults to the application singleton registry. */
  readonly registry?: Registry;
  /** Default buckets for histograms if not explicitly specified. */
  readonly defaultBuckets?: number[];
  /** Maximum number of distinct label combinations allowed per metric (default: 1000). */
  readonly maxCardinalityPerMetric?: number;
}

/**
 * Prometheus implementation of {@link MetricsRecorder} using `prom-client`.
 *
 * Enforces:
 * - Prometheus naming conventions
 * - Strict cardinality guards rejecting unbounded keys (e.g. user IDs, session IDs, tokens)
 *   and unbounded values (e.g. UUIDs, emails, JWTs)
 * - Shared singleton registry across the application
 */
export class PrometheusMetricsRecorder implements MetricsRecorder {
  readonly registry: Registry;
  private readonly defaultBuckets: number[];
  private readonly maxCardinalityPerMetric: number;
  private readonly distinctLabelSets = new Map<string, Set<string>>();
  private readonly metricLabelNames = new Map<string, string[]>();

  constructor(options: PrometheusMetricsRecorderOptions = {}) {
    this.registry = options.registry ?? getSharedRegistry();
    this.defaultBuckets = options.defaultBuckets ?? DEFAULT_LATENCY_BUCKETS;
    this.maxCardinalityPerMetric = options.maxCardinalityPerMetric ?? 1000;
  }

  /**
   * The MIME content type for Prometheus scrape exposition.
   */
  get contentType(): string {
    return this.registry.contentType;
  }

  /**
   * Returns Prometheus scrape metrics in text exposition format.
   */
  async metrics(): Promise<string> {
    return this.registry.metrics();
  }

  /**
   * Clears all registered metrics and local cardinality tracking.
   */
  clear(): void {
    this.registry.clear();
    this.distinctLabelSets.clear();
    this.metricLabelNames.clear();
  }

  incrementCounter(
    name: string,
    valueOrLabels?: number | MetricLabels,
    labelsOrValue?: MetricLabels | number,
  ): void {
    const { value, labels } = this.normalizeCounterArgs(valueOrLabels, labelsOrValue);
    this.validateMetricName(name);
    this.assertBoundedCardinality(name, labels);

    const stringLabels = this.convertLabels(labels);
    const counter = this.getOrCreateCounter(name, stringLabels);

    if (stringLabels && Object.keys(stringLabels).length > 0) {
      counter.inc(stringLabels, value);
    } else {
      counter.inc(value);
    }
  }

  recordHistogram(name: string, value: number, labels?: MetricLabels): void {
    this.validateMetricName(name);
    this.assertBoundedCardinality(name, labels);

    const stringLabels = this.convertLabels(labels);
    const histogram = this.getOrCreateHistogram(name, stringLabels);

    if (stringLabels && Object.keys(stringLabels).length > 0) {
      histogram.observe(stringLabels, value);
    } else {
      histogram.observe(value);
    }
  }

  setGauge(name: string, value: number, labels?: MetricLabels): void {
    this.validateMetricName(name);
    this.assertBoundedCardinality(name, labels);

    const stringLabels = this.convertLabels(labels);
    const gauge = this.getOrCreateGauge(name, stringLabels);

    if (stringLabels && Object.keys(stringLabels).length > 0) {
      gauge.set(stringLabels, value);
    } else {
      gauge.set(value);
    }
  }

  incrementGauge(name: string, value = 1, labels?: MetricLabels): void {
    this.validateMetricName(name);
    this.assertBoundedCardinality(name, labels);

    const stringLabels = this.convertLabels(labels);
    const gauge = this.getOrCreateGauge(name, stringLabels);

    if (stringLabels && Object.keys(stringLabels).length > 0) {
      gauge.inc(stringLabels, value);
    } else {
      gauge.inc(value);
    }
  }

  decrementGauge(name: string, value = 1, labels?: MetricLabels): void {
    this.validateMetricName(name);
    this.assertBoundedCardinality(name, labels);

    const stringLabels = this.convertLabels(labels);
    const gauge = this.getOrCreateGauge(name, stringLabels);

    if (stringLabels && Object.keys(stringLabels).length > 0) {
      gauge.dec(stringLabels, value);
    } else {
      gauge.dec(value);
    }
  }

  private validateMetricName(name: string): void {
    if (!name || typeof name !== "string" || !METRIC_NAME_REGEX.test(name)) {
      throw new InvalidMetricNameError(
        `Metric name '${name}' is invalid. Prometheus metric names must match ${METRIC_NAME_REGEX.toString()}.`,
      );
    }
  }

  /**
   * Cardinality guard enforcing low-cardinality label dimensions.
   */
  private assertBoundedCardinality(metricName: string, labels?: MetricLabels): void {
    if (!labels) return;

    for (const [key, rawVal] of Object.entries(labels)) {
      const normalizedKey = key.toLowerCase().replace(/[-_]/g, "");
      if (
        FORBIDDEN_LABEL_NAMES.has(normalizedKey) ||
        FORBIDDEN_LABEL_NAMES.has(key.toLowerCase())
      ) {
        throw new CardinalityGuardError(
          `Label key '${key}' on metric '${metricName}' violates bounded cardinality rules. Identifiers like user IDs and tokens must not be recorded as metric labels.`,
        );
      }

      if (rawVal === undefined || rawVal === null) continue;
      const valStr = String(rawVal);

      if (UUID_REGEX.test(valStr)) {
        throw new CardinalityGuardError(
          `Label value for '${key}' on metric '${metricName}' is a UUID ('${valStr}'), which creates unbounded timeseries cardinality.`,
        );
      }

      if (EMAIL_REGEX.test(valStr)) {
        throw new CardinalityGuardError(
          `Label value for '${key}' on metric '${metricName}' is an email address, which creates unbounded timeseries cardinality.`,
        );
      }

      if (JWT_REGEX.test(valStr) || valStr.length > 120) {
        throw new CardinalityGuardError(
          `Label value for '${key}' on metric '${metricName}' is excessively long or token-like, which creates unbounded timeseries cardinality.`,
        );
      }
    }

    const labelKeyFingerprint = JSON.stringify(labels);
    let labelSets = this.distinctLabelSets.get(metricName);
    if (!labelSets) {
      labelSets = new Set<string>();
      this.distinctLabelSets.set(metricName, labelSets);
    }

    if (!labelSets.has(labelKeyFingerprint)) {
      if (labelSets.size >= this.maxCardinalityPerMetric) {
        throw new CardinalityGuardError(
          `Metric '${metricName}' exceeded the maximum allowed cardinality limit of ${this.maxCardinalityPerMetric} distinct label combinations.`,
        );
      }
      labelSets.add(labelKeyFingerprint);
    }
  }

  private convertLabels(labels?: MetricLabels): LabelValues<string> | undefined {
    if (!labels) return undefined;
    const entries = Object.entries(labels)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => [k, typeof v === "boolean" ? String(v) : v] as const);
    return Object.fromEntries(entries);
  }

  private getOrCreateCounter(name: string, labels?: LabelValues<string>): Counter<string> {
    const existing = this.registry.getSingleMetric(name);
    if (existing) {
      if (existing instanceof Counter) {
        if (labels) {
          const currentLabelNames = this.metricLabelNames.get(name) ?? [];
          const newKeys = Object.keys(labels).filter((k) => !currentLabelNames.includes(k));
          if (newKeys.length > 0) {
            this.registry.removeSingleMetric(name);
            const combined = [...currentLabelNames, ...newKeys];
            this.metricLabelNames.set(name, combined);
            return new Counter({
              name,
              help: `${name} counter`,
              labelNames: combined,
              registers: [this.registry],
            });
          }
        }
        return existing;
      }
      throw new Error(`Metric '${name}' already registered in registry as non-Counter type.`);
    }

    const labelNames = labels ? Object.keys(labels) : [];
    this.metricLabelNames.set(name, labelNames);
    return new Counter({
      name,
      help: `${name} counter`,
      labelNames,
      registers: [this.registry],
    });
  }

  private getOrCreateHistogram(name: string, labels?: LabelValues<string>): Histogram<string> {
    const existing = this.registry.getSingleMetric(name);
    if (existing) {
      if (existing instanceof Histogram) {
        if (labels) {
          const currentLabelNames = this.metricLabelNames.get(name) ?? [];
          const newKeys = Object.keys(labels).filter((k) => !currentLabelNames.includes(k));
          if (newKeys.length > 0) {
            this.registry.removeSingleMetric(name);
            const combined = [...currentLabelNames, ...newKeys];
            this.metricLabelNames.set(name, combined);
            return new Histogram({
              name,
              help: `${name} histogram`,
              labelNames: combined,
              buckets: this.defaultBuckets,
              registers: [this.registry],
            });
          }
        }
        return existing;
      }
      throw new Error(`Metric '${name}' already registered in registry as non-Histogram type.`);
    }

    const labelNames = labels ? Object.keys(labels) : [];
    this.metricLabelNames.set(name, labelNames);
    return new Histogram({
      name,
      help: `${name} histogram`,
      labelNames,
      buckets: this.defaultBuckets,
      registers: [this.registry],
    });
  }

  private getOrCreateGauge(name: string, labels?: LabelValues<string>): Gauge<string> {
    const existing = this.registry.getSingleMetric(name);
    if (existing) {
      if (existing instanceof Gauge) {
        if (labels) {
          const currentLabelNames = this.metricLabelNames.get(name) ?? [];
          const newKeys = Object.keys(labels).filter((k) => !currentLabelNames.includes(k));
          if (newKeys.length > 0) {
            this.registry.removeSingleMetric(name);
            const combined = [...currentLabelNames, ...newKeys];
            this.metricLabelNames.set(name, combined);
            return new Gauge({
              name,
              help: `${name} gauge`,
              labelNames: combined,
              registers: [this.registry],
            });
          }
        }
        return existing;
      }
      throw new Error(`Metric '${name}' already registered in registry as non-Gauge type.`);
    }

    const labelNames = labels ? Object.keys(labels) : [];
    this.metricLabelNames.set(name, labelNames);
    return new Gauge({
      name,
      help: `${name} gauge`,
      labelNames,
      registers: [this.registry],
    });
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
}
