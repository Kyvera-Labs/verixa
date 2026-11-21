import { randomUUID } from "node:crypto";

import { trace } from "@opentelemetry/api";
import { Resource } from "@opentelemetry/resources";
import { NodeSDK, tracing } from "@opentelemetry/sdk-node";

/**
 * Standard semantic resource attribute names adhering to OpenTelemetry specifications.
 */
export const OTEL_RESOURCE_ATTRIBUTES = {
  SERVICE_NAME: "service.name",
  SERVICE_VERSION: "service.version",
  DEPLOYMENT_ENVIRONMENT: "deployment.environment",
  DEPLOYMENT_ID: "deployment.id",
  SERVICE_INSTANCE_ID: "service.instance.id",
} as const;

export type MemorySpanExporter = tracing.InMemorySpanExporter;

let activeMemoryExporter: tracing.InMemorySpanExporter | null = null;

/**
 * Returns the currently active InMemorySpanExporter if memory export is active.
 */
export function getActiveMemorySpanExporter(): tracing.InMemorySpanExporter | undefined {
  return activeMemoryExporter ?? undefined;
}

type NodeSdkConfiguration = NonNullable<ConstructorParameters<typeof NodeSDK>[0]>;

export interface OtelBootstrapOptions {
  /** Service name (defaults to OTEL_SERVICE_NAME or SERVICE_NAME or 'verixa-api'). */
  readonly serviceName?: string;
  /** Service version (defaults to SERVICE_VERSION or '0.1.0'). */
  readonly serviceVersion?: string;
  /** Environment name (defaults to NODE_ENV or 'development'). */
  readonly environment?: string;
  /** Deployment or instance ID (defaults to DEPLOYMENT_ID or random UUID). */
  readonly deploymentId?: string;
  /** Explicitly disable SDK initialization regardless of environment. */
  readonly disabled?: boolean;
  /** Force enable SDK even in test environment (useful for OTel integration tests). */
  readonly forceEnable?: boolean;
  /** Custom trace exporter. Defaults to an in-memory exporter when no OTLP endpoint is configured. */
  readonly traceExporter?: NodeSdkConfiguration["traceExporter"];
  /** Optional custom NodeSDK configuration overrides. */
  readonly sdkConfig?: Partial<ConstructorParameters<typeof NodeSDK>[0]>;
}

export interface OtelBootstrapResult {
  readonly active: boolean;
  readonly reason?: string;
  readonly attributes: {
    readonly [OTEL_RESOURCE_ATTRIBUTES.SERVICE_NAME]: string;
    readonly [OTEL_RESOURCE_ATTRIBUTES.SERVICE_VERSION]: string;
    readonly [OTEL_RESOURCE_ATTRIBUTES.DEPLOYMENT_ENVIRONMENT]: string;
    readonly [OTEL_RESOURCE_ATTRIBUTES.DEPLOYMENT_ID]: string;
    readonly [OTEL_RESOURCE_ATTRIBUTES.SERVICE_INSTANCE_ID]: string;
  };
  readonly sdk?: NodeSDK;
}

let activeSdk: NodeSDK | null = null;
let activeBootstrapResult: OtelBootstrapResult | null = null;
let bootstrapTimestamp: number | null = null;

/**
 * Returns whether OpenTelemetry tracing is currently initialized and active in this process.
 */
export function isOtelActive(): boolean {
  return activeBootstrapResult?.active === true;
}

/**
 * Returns the configured resource attributes for this process.
 */
export function getActiveResourceAttributes(): OtelBootstrapResult["attributes"] | undefined {
  return activeBootstrapResult?.attributes;
}

/**
 * Resolves the resource attributes from configuration or process environment.
 */
export function resolveResourceAttributes(
  options: OtelBootstrapOptions = {},
): OtelBootstrapResult["attributes"] {
  const serviceName =
    options.serviceName ||
    process.env.OTEL_SERVICE_NAME ||
    process.env.SERVICE_NAME ||
    "verixa-api";

  const serviceVersion =
    options.serviceVersion ||
    process.env.SERVICE_VERSION ||
    process.env.npm_package_version ||
    "0.1.0";

  const environment = options.environment || process.env.NODE_ENV || "development";

  const deploymentId =
    options.deploymentId || process.env.DEPLOYMENT_ID || process.env.HOSTNAME || randomUUID();

  return {
    [OTEL_RESOURCE_ATTRIBUTES.SERVICE_NAME]: serviceName,
    [OTEL_RESOURCE_ATTRIBUTES.SERVICE_VERSION]: serviceVersion,
    [OTEL_RESOURCE_ATTRIBUTES.DEPLOYMENT_ENVIRONMENT]: environment,
    [OTEL_RESOURCE_ATTRIBUTES.DEPLOYMENT_ID]: deploymentId,
    [OTEL_RESOURCE_ATTRIBUTES.SERVICE_INSTANCE_ID]: deploymentId,
  };
}

/**
 * Initializes the OpenTelemetry Node SDK at process start.
 *
 * ## Require-Order Constraint
 *
 * OpenTelemetry monkey-patches Node's internal `require` / ESM loader hooks to intercept
 * module loads and inject tracing context (for Fastify, HTTP, database clients). If any
 * instrumented module is imported BEFORE this bootstrap function executes, that module
 * bypasses the patching seam and runs uninstrumented.
 *
 * ## Test Environment Cleanliness
 *
 * In `test` environments (`NODE_ENV === 'test'`), the SDK is disabled by default to prevent
 * noisy exporter errors, open network sockets, or unhandled promise rejections in CI pipelines.
 */
export function initOtelBootstrap(options: OtelBootstrapOptions = {}): OtelBootstrapResult {
  if (activeBootstrapResult && activeBootstrapResult.active) {
    return activeBootstrapResult;
  }

  const attributes = resolveResourceAttributes(options);
  const isTestEnv = (process.env.NODE_ENV || "").toLowerCase() === "test";
  const isDisabledByEnv = process.env.OTEL_SDK_DISABLED === "true";
  const shouldDisable =
    options.disabled === true || (!options.forceEnable && (isTestEnv || isDisabledByEnv));

  if (shouldDisable) {
    const result: OtelBootstrapResult = {
      active: false,
      reason: isTestEnv ? "disabled_in_test_environment" : "disabled_by_configuration",
      attributes,
    };
    activeBootstrapResult = result;
    return result;
  }

  const resource = new Resource(attributes);

  let spanProcessor = options.sdkConfig?.spanProcessor;
  const traceExporter = options.traceExporter;

  if (
    !spanProcessor &&
    !traceExporter &&
    !process.env.OTEL_EXPORTER_OTLP_ENDPOINT &&
    !options.sdkConfig?.traceExporter
  ) {
    activeMemoryExporter = new tracing.InMemorySpanExporter();
    spanProcessor = new tracing.SimpleSpanProcessor(activeMemoryExporter);
  }

  const sdk = new NodeSDK({
    resource,
    ...(spanProcessor ? { spanProcessor } : {}),
    ...(traceExporter !== undefined ? { traceExporter } : {}),
    ...options.sdkConfig,
  });

  sdk.start();

  activeSdk = sdk;
  bootstrapTimestamp = Date.now();
  const result: OtelBootstrapResult = {
    active: true,
    attributes,
    sdk,
  };
  activeBootstrapResult = result;

  return result;
}

/**
 * Shuts down the OpenTelemetry SDK cleanly and flushes remaining spans.
 */
export async function shutdownOtel(): Promise<void> {
  if (activeSdk) {
    await activeSdk.shutdown();
    activeSdk = null;
  }
  if (activeMemoryExporter) {
    await activeMemoryExporter.shutdown();
    activeMemoryExporter = null;
  }
  activeBootstrapResult = null;
  bootstrapTimestamp = null;
  trace.disable();
}

/**
 * Validates that OpenTelemetry bootstrap occurred before a given target timestamp
 * (e.g. application module loading timestamp).
 */
export function assertBootstrapLoadOrder(applicationLoadTimestamp?: number): boolean {
  if (!isOtelActive()) {
    // If disabled in test, load-order check is trivially satisfied (no-op)
    return true;
  }
  if (!bootstrapTimestamp) {
    return false;
  }
  if (applicationLoadTimestamp && bootstrapTimestamp > applicationLoadTimestamp) {
    throw new Error(
      `OpenTelemetry bootstrap load order violation: SDK initialized at ${bootstrapTimestamp}, after application module loaded at ${applicationLoadTimestamp}.`,
    );
  }
  return true;
}
