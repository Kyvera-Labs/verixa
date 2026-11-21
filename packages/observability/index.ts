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

export {
  bindRequestContext,
  clearRequestContext,
  getActiveTraceId,
  getCorrelationId,
  getRequestContext,
  getTraceId,
  requestContextStorage,
  runWithRequestContext,
  type RequestContextData,
} from "./infrastructure/request-context.js";

export {
  DEFAULT_REDACT_PATHS,
  createContextualLogger,
  type ContextualLoggerOptions,
  type Logger,
} from "./infrastructure/logger.js";

export {
  HealthCheckRegistry,
  createPostgresHealthCheck,
  createRedisHealthCheck,
  type DependencyCheckFn,
  type DependencyCheckRegistration,
  type DependencyCheckResult,
  type DependencyStatus,
  type HealthCheckRegistryOptions,
  type HealthCheckResult,
} from "./application/health-check-registry.js";
