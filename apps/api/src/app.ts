import { createLogger, type Logger } from "@verixa/shared-kernel";
import Fastify from "fastify";

/**
 * Return type is inferred rather than annotated as `FastifyInstance`: the
 * default `FastifyInstance` generic assumes Fastify's own `FastifyBaseLogger`
 * type, which isn't structurally identical to the concrete pino `Logger`
 * `loggerInstance` produces (Fastify's own type doesn't require `msgPrefix`,
 * for example) — the inferred type is more specific and equally safe.
 */
export function buildApp(logger: Logger = createLogger({ name: "verixa-api" })) {
  const app = Fastify({ loggerInstance: logger });

  app.get("/health", () => {
    return { status: "ok" };
  });

  return app;
}
