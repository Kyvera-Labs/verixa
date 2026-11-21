import type { HealthCheckRegistry } from "@verixa/observability";
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyTypeProvider,
  FastifyTypeProviderDefault,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerBase,
  RawServerDefault,
} from "fastify";

export interface HealthRouteOptions {
  readonly healthCheckRegistry?: HealthCheckRegistry | undefined;
}

/**
 * Registers Liveness (/health/live, /health) and Readiness (/health/ready) endpoints.
 *
 * Liveness (/health/live):
 * Evaluates whether the Node.js event loop is alive and responding. Never queries
 * external dependencies (Postgres, Redis) to avoid cascading container restarts
 * during transient infrastructure blips.
 *
 * Readiness (/health/ready):
 * Validates connectivity to required external dependencies (Postgres, Redis)
 * using lightweight pings with bounded timeouts. Returns 200 only when all
 * required dependencies report up; otherwise returns 503 with per-dependency status.
 */
export function registerHealthRoutes<
  Server extends RawServerBase = RawServerDefault,
  Request extends RawRequestDefaultExpression<Server> = RawRequestDefaultExpression<Server>,
  Reply extends RawReplyDefaultExpression<Server> = RawReplyDefaultExpression<Server>,
  Logger extends FastifyBaseLogger = FastifyBaseLogger,
  TypeProvider extends FastifyTypeProvider = FastifyTypeProviderDefault,
>(
  app: FastifyInstance<Server, Request, Reply, Logger, TypeProvider>,
  options: HealthRouteOptions = {},
): void {
  // Liveness endpoints (Kubernetes liveness probe)
  app.get("/health/live", (_request, reply) => {
    return reply.status(200).send({ status: "ok" });
  });

  // Backward-compatible alias for existing health probes
  app.get("/health", (_request, reply) => {
    return reply.status(200).send({ status: "ok" });
  });

  // Readiness endpoint (Kubernetes readiness probe)
  app.get("/health/ready", async (_request, reply) => {
    if (!options.healthCheckRegistry) {
      // If no registry is configured (e.g. lightweight test app), return ok
      return reply.status(200).send({
        status: "healthy",
        timestamp: new Date().toISOString(),
        durationMs: 0,
        dependencies: {},
      });
    }

    const result = await options.healthCheckRegistry.check();
    const statusCode = result.status === "healthy" ? 200 : 503;
    return reply.status(statusCode).send(result);
  });
}
