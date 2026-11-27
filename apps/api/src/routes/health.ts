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
 * Registers liveness (`/health/live`, `/health`) and readiness (`/health/ready`).
 *
 * Liveness only checks that the event loop responds and never touches dependencies, so a transient
 * database blip does not restart every container. Readiness pings the required dependencies
 * (Postgres, Redis) with bounded timeouts and returns 503 with per-dependency status unless all are
 * up.
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
