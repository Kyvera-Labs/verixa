export {
  bootstrapOtel,
  ErrorAwareRatioSampler,
  NoopSpanExporter,
  OtelBootstrapError,
  OtlpSpanExporter,
  otelConfigFromAppConfig,
  validateOtelBootstrapConfig,
} from "./infrastructure/otel-bootstrap.js";
export type {
  OtelBootstrapConfig,
  OtelBootstrapHandle,
  OtelResourceAttributes,
  SamplingDecision,
  SpanExporter,
  SpanRecord,
  SpanStatusCode,
  TraceSampler,
} from "./infrastructure/otel-bootstrap.js";

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
