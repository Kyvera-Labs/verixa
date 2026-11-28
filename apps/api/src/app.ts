import { fileURLToPath } from "node:url";

import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import {
  createContextualLogger,
  getSharedRegistry,
  HealthCheckRegistry,
  NoopMetricsRecorder,
  PrometheusMetricsRecorder,
  type Logger,
  type MetricsRecorder,
} from "@verixa/observability";
import Fastify from "fastify";

import { registerContextRoutes } from "./composition/register-routes.js";
import type { Container } from "./composition-root.js";
import { registerGraphQLServer } from "./graphql/server.js";
import { errorResponseSchema, handleApiError } from "./http/error-response.js";
import { assertRouteValidationSchemas } from "./http/route-validation.js";
import { enforceRegisteredRouteSchemas } from "./openapi/zod-registry.js";
import {
  DOCS_CONTENT_SECURITY_POLICY,
  registerBaselineResponseHeaders,
} from "./plugins/baseline-response-headers.js";
import { NO_CORS, registerCors, type CorsPolicy } from "./plugins/cors.js";
import { registerHttpMetrics, type HttpMetricsOptions } from "./plugins/http-metrics.js";
import { registerRateLimit, type RateLimitPluginOptions } from "./plugins/rate-limit.js";
import { registerRequestContext } from "./plugins/request-context.js";
import {
  NO_TRANSPORT_SECURITY,
  registerSecurityHeaders,
  type HstsDirective,
  type SecurityHeadersOptions,
} from "./plugins/security-headers.js";
import { registerCspReportRoute } from "./routes/csp-report.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerSecurityTxtRoute } from "./routes/well-known/security-txt.js";

/**
 * Re-exported so callers (and the integration suite) can name the policy
 * without reaching into `src/plugins/` — `apps/api`'s public surface is
 * `./app` and `./composition-root`, and adding a third subpath to
 * `package.json` for two types would be more ceremony than content.
 */
export type { HstsDirective, SecurityHeadersOptions };

/**
 * Re-exported for the same reason the security-header types are: callers and
 * the integration suite should be able to name the policy without reaching
 * into `src/plugins/`.
 */
export type { CorsPolicy, RateLimitPluginOptions };
export type { HttpMetricsOptions };
export { registerHttpMetrics };

/** Re-exported for the integration suite, which builds a GraphQL-only app around a test container. */
export { createGraphQLApp } from "./graphql/server.js";

export interface BuildAppOptions {
  readonly logger?: Logger | undefined;
  /**
   * The object graph the routes call into. Optional so `/health` works without a database. Without
   * it, authenticated routes are not registered, so they return 404 rather than failing with 500.
   */
  readonly container?: Container | undefined;
  /**
   * Transport-security response controls. Defaults to `NO_TRANSPORT_SECURITY` (no HSTS, no HTTPS
   * redirect) for in-process tests; `server.ts` always derives it from validated config.
   */
  readonly securityHeaders?: SecurityHeadersOptions | undefined;
  /**
   * The cross-origin browser policy.
   *
   * Defaults to `NO_CORS` — an empty allowlist — for the same reason
   * `securityHeaders` defaults to the nothing-on shape: the callers that pass
   * nothing are in-process tests, and `server.ts` always derives this from
   * validated configuration. Reading the environment here would create a
   * second, unvalidated config path.
   */
  readonly cors?: CorsPolicy | undefined;
  /**
   * Honour `X-Forwarded-Proto` / `X-Forwarded-For` from an upstream proxy.
   *
   * Off unless a deployment says it sits behind one. Trusting those headers
   * with no proxy in front is how a caller picks its own apparent IP and
   * scheme; see `docs/security/tls-enforcement.md`.
   */
  readonly trustProxy?: boolean;
  /**
   * Rate-limiting response controls.
   *
   * Defaults to active in non-test environments (`process.env["NODE_ENV"] !== "test"`).
   * Pass `false` to disable or pass a configuration object to tune limits.
   */
  readonly rateLimit?: boolean | RateLimitPluginOptions;
  /**
   * Operational metrics recorder.
   * When provided, registers HTTP golden signal metrics hooks across all routes.
   */
  readonly metricsRecorder?: MetricsRecorder | undefined;
  /**
   * Health-check registry orchestrating dependency readiness probes.
   */
  readonly healthCheckRegistry?: HealthCheckRegistry | undefined;
  /**
   * Serve the Prometheus scrape endpoint at GET /metrics. Off by default:
   * it exposes route names, request volumes and error rates, so it is
   * enabled only where something (normally an internal scraper) needs
   * it. Wired from METRICS_ENABLED.
   */
  readonly metricsEndpoint?: boolean | undefined;
}

/**
 * Return type is inferred rather than annotated as `FastifyInstance`: the
 * default `FastifyInstance` generic assumes Fastify's own `FastifyBaseLogger`
 * type, which isn't structurally identical to the concrete pino `Logger`
 * `loggerInstance` produces (Fastify's own type doesn't require `msgPrefix`,
 * for example) — the inferred type is more specific and equally safe.
 */
export function buildApp(options: BuildAppOptions = {}) {
  const isTest = process.env["NODE_ENV"] === "test";
  const logger =
    options.logger ??
    options.container?.observability?.logger ??
    createContextualLogger({
      name: "verixa-api",
      level: isTest ? "silent" : "info",
    });
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: options.trustProxy ?? false,
    ajv: {
      customOptions: {
        /**
         * Reject unknown properties instead of silently stripping them, so a client sending a field
         * the API ignores gets a 400 rather than a misleading success.
         */
        removeAdditional: false,
      },
    },
  });

  registerCors(app, options.cors ?? NO_CORS);

  const enableRateLimit =
    options.rateLimit !== undefined
      ? options.rateLimit !== false
      : process.env["NODE_ENV"] !== "test";

  if (enableRateLimit) {
    const rateLimitOpts = typeof options.rateLimit === "object" ? options.rateLimit : {};
    registerRateLimit(app, rateLimitOpts);
  }

  app.setErrorHandler(handleApiError);
  app.addSchema(errorResponseSchema);
  app.addHook("onRoute", (route) => assertRouteValidationSchemas(route));

  // Baseline response headers, registered before any route exists
  // so "all routes return the configured header set" is true by construction
  // rather than by every route remembering to ask. `/health` below is the proof:
  // it is the one endpoint a deployment is most likely to expose without
  // thinking about it. The `Strict-Transport-Security` pin is a separate,
  // config-driven concern (`./plugins/security-headers.js`) and is
  // deliberately not set here.
  registerBaselineResponseHeaders(app);

  // Request context and correlation ID linkage
  registerRequestContext(app);

  // Operational metrics recorder
  const metricsRecorder =
    options.metricsRecorder ??
    options.container?.observability?.metricsRecorder ??
    (isTest ? new NoopMetricsRecorder() : new PrometheusMetricsRecorder());
  registerHttpMetrics(app, { recorder: metricsRecorder });

  // Health-check registry orchestrating liveness (/health/live, /health) and readiness (/health/ready) probes
  const healthCheckRegistry =
    options.healthCheckRegistry ??
    options.container?.observability?.healthCheckRegistry ??
    new HealthCheckRegistry();
  registerHealthRoutes(app, { healthCheckRegistry });

  // Prometheus scrape endpoint
  if (options.metricsEndpoint === true) {
    app.get("/metrics", async (_request, reply) => {
      const registry = getSharedRegistry();
      const metrics = await registry.metrics();
      return reply.header("content-type", registry.contentType).send(metrics);
    });
  }

  if (process.env["NODE_ENV"] !== "production") {
    app.register(fastifySwagger, {
      mode: "static",
      specification: {
        path: fileURLToPath(new URL("../openapi/openapi.yaml", import.meta.url)),
        baseDir: fileURLToPath(new URL("../openapi", import.meta.url)),
      },
    });
    app.register(fastifySwaggerUi, {
      routePrefix: "/docs",
      // The documentation page is the one response here a browser renders, so it
      // is the one place the baseline `default-src 'none'` cannot be used. This
      // replaces swagger-ui's own `staticCSP: true` policy with a tighter one;
      // every difference is reasoned out in
      // `plugins/baseline-response-headers.ts`, next to the value.
      staticCSP: DOCS_CONTENT_SECURITY_POLICY,
      uiConfig: {
        docExpansion: "list",
        deepLinking: true,
        url: "/docs/openapi.json",
      },
    });
    app.get("/docs/openapi.json", () => app.swagger());
  }

  const notificationWorker = options.container?.notifications?.worker;
  if (notificationWorker !== undefined) {
    // Public and unauthenticated, so only the running flag: the worker's
    // lastError can carry provider hostnames or connection details.
    app.get("/health/notifications", () => ({ running: notificationWorker.health().running }));
  }

  // Kept separate from liveness so deployments can verify which immutable
  // image is serving traffic without making health probes depend on metadata.
  app.get("/version", () => ({ version: process.env["VERIXA_BUILD_VERSION"] ?? "unknown" }));

  // Registered outside the container check for the same reason `/health` is:
  // the disclosure channel describes the software, not a tenant's data, and a
  // researcher's scanner should find it on a process that has no database.
  registerSecurityTxtRoute(app);
  registerCspReportRoute(app);

  void registerGraphQLServer(app, { container: options.container });

  // Registered on `app` itself, in the same encapsulation context as every
  // route below, so it covers `/health` and the authenticated routes alike.
  // See the comment on `registerSecurityHeaders` for why this is not a
  // `register()`-style plugin.
  registerSecurityHeaders(app, options.securityHeaders ?? NO_TRANSPORT_SECURITY);

  if (options.container !== undefined) {
    // Routes are registered once, by `registerContextRoutes`, which mounts each module at its
    // public prefix. The REST modules share one unprefixed scope so the registered-schema guard
    // covers them but not Mercurius's `/graphql` route.
    const container = options.container;
    app.register((rest) => {
      enforceRegisteredRouteSchemas(rest);
      registerContextRoutes(rest, container);
    });
  }

  return app;
}
