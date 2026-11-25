import {
  type Config,
  isValidOtlpEndpoint,
  OTEL_EXPORTER_PROTOCOLS,
  type OtelExporterProtocol,
  resolveOtelSamplingRate,
} from "@verixa/config";

export type SpanStatusCode = "UNSET" | "OK" | "ERROR";

export interface SpanRecord {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string | undefined;
  readonly name: string;
  readonly startTimeUnixNano: bigint;
  readonly endTimeUnixNano: bigint;
  readonly status: {
    readonly code: SpanStatusCode;
    readonly message?: string | undefined;
  };
  readonly attributes?: Readonly<Record<string, string | number | boolean>> | undefined;
}

export interface SamplingDecision {
  readonly sampled: boolean;
  readonly reason: "error-force-sampled" | "rate-sampled" | "rate-dropped";
}

export interface TraceSampler {
  shouldSample(span: SpanRecord): SamplingDecision;
}

export interface SpanExporter {
  export(spans: readonly SpanRecord[]): Promise<void>;
  shutdown(): Promise<void>;
}

export interface OtelResourceAttributes {
  readonly "service.name": string;
  readonly "service.version": string;
  readonly "deployment.environment": "development" | "test" | "production";
}

export interface OtelBootstrapConfig {
  readonly environment: "development" | "test" | "production";
  readonly serviceName: string;
  readonly serviceVersion?: string | undefined;
  readonly endpoint?: string | undefined;
  readonly protocol: OtelExporterProtocol;
  readonly headers: Readonly<Record<string, string>>;
  readonly samplingRate: number;
  readonly exporter?: SpanExporter | undefined;
  readonly random?: (() => number) | undefined;
}

export interface OtelBootstrapHandle {
  readonly enabled: boolean;
  readonly resource: OtelResourceAttributes;
  readonly sampler: TraceSampler;
  readonly exporter: SpanExporter;
  readonly protocol: OtelExporterProtocol;
  readonly endpoint: string | undefined;
  recordSpan(span: SpanRecord): Promise<SamplingDecision>;
  shutdown(): Promise<void>;
}

/**
 * Thrown when OTLP exporter or sampling configuration is invalid at startup.
 * Failing fast prevents silent trace loss or broken collector URLs in production.
 */
export class OtelBootstrapError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OtelBootstrapError";
  }
}

/**
 * Validates OTLP exporter and sampling configuration so invalid settings fail
 * fast at startup even when `bootstrapOtel` is called directly without `loadConfig`.
 */
export function validateOtelBootstrapConfig(config: OtelBootstrapConfig): void {
  if (config.serviceName.trim().length === 0) {
    throw new OtelBootstrapError("OTEL_SERVICE_NAME must be a non-empty string.");
  }

  if (!OTEL_EXPORTER_PROTOCOLS.includes(config.protocol)) {
    throw new OtelBootstrapError(
      `Unsupported OTLP protocol "${String(config.protocol)}". Expected one of: ${OTEL_EXPORTER_PROTOCOLS.join(", ")}.`,
    );
  }

  if (config.endpoint !== undefined && !isValidOtlpEndpoint(config.endpoint)) {
    throw new OtelBootstrapError(
      `Invalid OTLP exporter endpoint "${config.endpoint}". Expected a valid http:// or https:// URL.`,
    );
  }

  if (
    typeof config.samplingRate !== "number" ||
    !Number.isFinite(config.samplingRate) ||
    config.samplingRate < 0 ||
    config.samplingRate > 1
  ) {
    throw new OtelBootstrapError(
      `Invalid OTEL_TRACES_SAMPLER_RATE "${String(config.samplingRate)}". Expected a finite number between 0 and 1.`,
    );
  }
}

/**
 * Builds an {@link OtelBootstrapConfig} from the validated application {@link Config}.
 */
export function otelConfigFromAppConfig(
  config: Config,
  overrides: {
    readonly serviceVersion?: string | undefined;
    readonly exporter?: SpanExporter | undefined;
    readonly random?: (() => number) | undefined;
  } = {},
): OtelBootstrapConfig {
  return {
    environment: config.NODE_ENV,
    serviceName: config.OTEL_SERVICE_NAME,
    serviceVersion: overrides.serviceVersion ?? "0.1.0",
    endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
    protocol: config.OTEL_EXPORTER_OTLP_PROTOCOL,
    headers: config.OTEL_EXPORTER_OTLP_HEADERS,
    samplingRate: resolveOtelSamplingRate(config.NODE_ENV, config.OTEL_TRACES_SAMPLER_RATE),
    exporter: overrides.exporter,
    random: overrides.random,
  };
}

/**
 * Probabilistic trace sampler that unconditionally force-samples error spans.
 *
 * Head-based ratio sampling bounds trace volume and collector cost in
 * production, while the error override ensures that failing requests are never
 * dropped regardless of the configured sampling rate (even at 0%).
 */
export class ErrorAwareRatioSampler implements TraceSampler {
  private readonly samplingRate: number;
  private readonly random: () => number;

  constructor(samplingRate: number, random: () => number = Math.random) {
    if (!Number.isFinite(samplingRate) || samplingRate < 0 || samplingRate > 1) {
      throw new OtelBootstrapError(
        `Sampling rate must be a finite number between 0 and 1, received ${String(samplingRate)}.`,
      );
    }
    this.samplingRate = samplingRate;
    this.random = random;
  }

  shouldSample(span: SpanRecord): SamplingDecision {
    if (span.status.code === "ERROR") {
      return { sampled: true, reason: "error-force-sampled" };
    }

    if (this.samplingRate >= 1) {
      return { sampled: true, reason: "rate-sampled" };
    }

    if (this.samplingRate <= 0) {
      return { sampled: false, reason: "rate-dropped" };
    }

    const sampled = this.random() < this.samplingRate;
    return { sampled, reason: sampled ? "rate-sampled" : "rate-dropped" };
  }
}

/**
 * No-op exporter used in test environments or when no OTLP endpoint is configured.
 */
export class NoopSpanExporter implements SpanExporter {
  export(): Promise<void> {
    // Intentionally a no-op.
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    // Intentionally a no-op.
    return Promise.resolve();
  }
}

export interface OtlpSpanExporterOptions {
  readonly endpoint: string;
  readonly protocol: OtelExporterProtocol;
  readonly headers: Readonly<Record<string, string>>;
  readonly resource: OtelResourceAttributes;
  readonly fetchImpl?: ((input: string, init?: RequestInit) => Promise<Response>) | undefined;
}

/**
 * Collector-agnostic OTLP span exporter.
 *
 * Encapsulates OTLP transport details behind the {@link SpanExporter} port so
 * nothing above this layer depends on a specific collector vendor or SDK.
 */
export class OtlpSpanExporter implements SpanExporter {
  private readonly tracesUrl: string;
  private readonly protocol: OtelExporterProtocol;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly resource: OtelResourceAttributes;
  private readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  private closed = false;

  constructor(options: OtlpSpanExporterOptions) {
    if (!isValidOtlpEndpoint(options.endpoint)) {
      throw new OtelBootstrapError(
        `Invalid OTLP exporter endpoint "${options.endpoint}". Expected a valid http:// or https:// URL.`,
      );
    }
    this.protocol = options.protocol;
    this.headers = { ...options.headers };
    this.resource = options.resource;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.tracesUrl = resolveTracesUrl(options.endpoint, options.protocol);
  }

  async export(spans: readonly SpanRecord[]): Promise<void> {
    if (this.closed || spans.length === 0) {
      return;
    }

    const contentType =
      this.protocol === "http/protobuf"
        ? "application/x-protobuf"
        : this.protocol === "grpc"
          ? "application/grpc"
          : "application/json";

    const payload = JSON.stringify({
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: this.resource["service.name"] } },
              { key: "service.version", value: { stringValue: this.resource["service.version"] } },
              {
                key: "deployment.environment",
                value: { stringValue: this.resource["deployment.environment"] },
              },
            ],
          },
          scopeSpans: [
            {
              spans: spans.map((span) => ({
                traceId: span.traceId,
                spanId: span.spanId,
                parentSpanId: span.parentSpanId,
                name: span.name,
                startTimeUnixNano: span.startTimeUnixNano.toString(),
                endTimeUnixNano: span.endTimeUnixNano.toString(),
                status: span.status,
                attributes: span.attributes ?? {},
              })),
            },
          ],
        },
      ],
    });

    const response = await this.fetchImpl(this.tracesUrl, {
      method: "POST",
      headers: {
        "content-type": contentType,
        ...this.headers,
      },
      body: payload,
    });

    if (!response.ok) {
      throw new OtelBootstrapError(
        `OTLP export to ${this.tracesUrl} failed with HTTP ${String(response.status)}.`,
      );
    }
  }

  shutdown(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

function resolveTracesUrl(endpoint: string, protocol: OtelExporterProtocol): string {
  const normalized = endpoint.replace(/\/+$/, "");
  if (protocol === "grpc") {
    return normalized;
  }
  return normalized.endsWith("/v1/traces") ? normalized : `${normalized}/v1/traces`;
}

/**
 * Initializes OpenTelemetry tracing with validated OTLP exporter configuration
 * and the error-aware probabilistic sampling policy.
 *
 * Cleanly disables export in `test` environments (or when no endpoint is
 * configured) while still validating all configuration eagerly at startup.
 */
export function bootstrapOtel(config: OtelBootstrapConfig): OtelBootstrapHandle {
  validateOtelBootstrapConfig(config);

  const resource: OtelResourceAttributes = Object.freeze({
    "service.name": config.serviceName,
    "service.version": config.serviceVersion ?? "0.1.0",
    "deployment.environment": config.environment,
  });

  const sampler = new ErrorAwareRatioSampler(config.samplingRate, config.random);

  const enabled =
    config.environment !== "test" &&
    (config.endpoint !== undefined || config.exporter !== undefined);

  const exporter: SpanExporter = !enabled
    ? new NoopSpanExporter()
    : (config.exporter ??
      new OtlpSpanExporter({
        endpoint: config.endpoint!,
        protocol: config.protocol,
        headers: config.headers,
        resource,
      }));

  return {
    enabled,
    resource,
    sampler,
    exporter,
    protocol: config.protocol,
    endpoint: config.endpoint,
    async recordSpan(span: SpanRecord): Promise<SamplingDecision> {
      const decision = sampler.shouldSample(span);
      if (enabled && decision.sampled) {
        await exporter.export([span]);
      }
      return decision;
    },
    async shutdown(): Promise<void> {
      await exporter.shutdown();
    },
  };
}
