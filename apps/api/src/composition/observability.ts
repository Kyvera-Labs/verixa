import {
  createContextualLogger,
  createPostgresHealthCheck,
  createRedisHealthCheck,
  HealthCheckRegistry,
  NoopMetricsRecorder,
  PrometheusMetricsRecorder,
  type Logger,
  type MetricsRecorder,
} from "@verixa/observability";

export interface ObservabilityContainer {
  readonly logger: Logger;
  readonly metricsRecorder: MetricsRecorder;
  readonly healthCheckRegistry: HealthCheckRegistry;
  readonly shutdown: () => Promise<void>;
}

export interface ObservabilityOptions {
  readonly serviceName?: string | undefined;
  readonly environment?: string | undefined;
  readonly logLevel?: string | undefined;
  readonly prisma?: { $queryRaw: (template: TemplateStringsArray) => Promise<unknown> } | undefined;
  readonly redis?: { ping: () => Promise<string> } | undefined;
  readonly metricsRecorder?: MetricsRecorder | undefined;
  readonly healthCheckTimeoutMs?: number | undefined;
}

/**
 * Composition root wiring for cross-cutting observability concerns.
 *
 * Coordinates:
 * 1. OpenTelemetry SDK initialization (with clean test no-op).
 * 2. Metrics recorder port adapter (Prometheus in production/development, Noop in tests).
 * 3. Contextual structured logger with correlation IDs and trace ID linkage.
 * 4. Health-check registry with bounded timeouts for PostgreSQL and Redis dependencies.
 */
export function createObservabilityComponents(
  options: ObservabilityOptions = {},
): ObservabilityContainer {
  const env = options.environment ?? process.env["NODE_ENV"] ?? "development";
  const isTest = env === "test";

  // 1. OpenTelemetry SDK bootstrap: disabled in test to keep CI output clean
  // Tracing is not started here yet: the OpenTelemetry bootstrap on main
  // (bootstrapOtel, #592) must run before instrumented modules load, which a
  // composition-time call cannot guarantee. See docs/guides/observability.md.

  // 2. Metrics recorder: callers can inject a recorder, or defaults to Prometheus/Noop
  const metricsRecorder =
    options.metricsRecorder ??
    (isTest ? new NoopMetricsRecorder() : new PrometheusMetricsRecorder());

  // 3. Contextual structured logger with request correlation & taxonomy mixin
  const logger = createContextualLogger({
    name: options.serviceName ?? "verixa-api",
    level: options.logLevel ?? (isTest ? "silent" : "info"),
  });

  // 4. Health check registry
  const healthCheckRegistry = new HealthCheckRegistry({
    defaultTimeoutMs: options.healthCheckTimeoutMs ?? 2000,
  });

  if (options.prisma) {
    healthCheckRegistry.register(
      createPostgresHealthCheck(options.prisma, {
        timeoutMs: options.healthCheckTimeoutMs ?? 2000,
        required: true,
      }),
    );
  }

  if (options.redis) {
    healthCheckRegistry.register(
      createRedisHealthCheck(options.redis, {
        timeoutMs: options.healthCheckTimeoutMs ?? 2000,
        required: true,
      }),
    );
  }

  return {
    logger,
    metricsRecorder,
    healthCheckRegistry,
    shutdown: () => Promise.resolve(),
  };
}
