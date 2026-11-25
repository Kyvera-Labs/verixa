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
