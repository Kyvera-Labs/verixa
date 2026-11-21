export type {
  MetricLabelValue,
  MetricLabels,
  MetricsRecorder,
} from "./application/ports/metrics.js";

export {
  NoopMetricsRecorder,
  type NoopMetricsRecorderOptions,
  type RecordedMetricCall,
} from "./infrastructure/noop-metrics-recorder.js";

export {
  CardinalityGuardError,
  DEFAULT_LATENCY_BUCKETS,
  InvalidMetricNameError,
  PrometheusMetricsRecorder,
  getSharedRegistry,
  resetSharedRegistry,
  type PrometheusMetricsRecorderOptions,
} from "./infrastructure/prometheus-metrics-recorder.js";

export {
  OTEL_RESOURCE_ATTRIBUTES,
  assertBootstrapLoadOrder,
  getActiveMemorySpanExporter,
  getActiveResourceAttributes,
  initOtelBootstrap,
  isOtelActive,
  resolveResourceAttributes,
  shutdownOtel,
  type MemorySpanExporter,
  type OtelBootstrapOptions,
  type OtelBootstrapResult,
} from "./infrastructure/otel-bootstrap.js";
