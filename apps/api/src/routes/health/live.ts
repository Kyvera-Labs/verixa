import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";

/**
 * `GET /health/live` (Issue 357 / #469).
 *
 * Minimal Kubernetes-style liveness probe. Answers a single question:
 * "is this Node.js process alive and is its event loop responsive?"
 *
 * Deliberately takes no `container` and performs zero I/O (no Postgres,
 * no Redis, no external HTTP calls). Conflating liveness with dependency
 * health causes orchestrators to restart healthy API pods during a brief
 * database or cache blip, turning a single downstream outage into a
 * cascading restart storm. Dependency checks belong on a separate readiness
 * probe.
 *
 * Excluded from authentication (registered outside the authenticated REST
 * scope) and from rate limiting (`config.rateLimit.skip = true`) so probe
 * traffic from orchestrators and load balancers is never throttled.
 */
export function registerLivenessRoute<TLogger extends FastifyBaseLogger>(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression,
    RawReplyDefaultExpression,
    TLogger
  >,
): void {
  app.get(
    "/health/live",
    {
      config: {
        rateLimit: {
          skip: true,
        },
      },
      schema: {
        response: {
          200: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["ok"] },
            },
            required: ["status"],
            additionalProperties: false,
          },
        },
      },
    },
    () => ({ status: "ok" as const }),
  );
}
