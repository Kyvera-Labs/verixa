import { createLogger, type Logger } from "@verixa/shared-kernel";
import Fastify from "fastify";

import type { Container } from "./composition-root.js";
import { registerSecurityHeaders } from "./plugins/security-headers.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerCspReportRoute } from "./routes/csp-report.js";
import { registerSecurityTxtRoute } from "./routes/well-known/security-txt.js";

export interface BuildAppOptions {
  readonly logger?: Logger;
  /**
   * The object graph the routes call into.
   *
   * Optional so `/health` can be exercised without a database — a health
   * check that required Postgres to be reachable would be reporting on the
   * database rather than on the process, and would fail during exactly the
   * startup window an orchestrator uses it to survive.
   *
   * When absent, the authenticated routes are simply not registered. That is
   * better than registering routes that throw on first use: a 404 says "this
   * server was not built with that capability", where a 500 says "it is
   * broken", and only one of those is true.
   */
  readonly container?: Container;
}

/**
 * Return type is inferred rather than annotated as `FastifyInstance`: the
 * default `FastifyInstance` generic assumes Fastify's own `FastifyBaseLogger`
 * type, which isn't structurally identical to the concrete pino `Logger`
 * `loggerInstance` produces (Fastify's own type doesn't require `msgPrefix`,
 * for example) — the inferred type is more specific and equally safe.
 */
export function buildApp(options: BuildAppOptions = {}) {
  const logger = options.logger ?? createLogger({ name: "verixa-api" });
  const app = Fastify({
    loggerInstance: logger,
    ajv: {
      customOptions: {
        /**
         * Reject unknown properties instead of silently stripping them.
         *
         * Fastify's default is `removeAdditional: true`, which deletes
         * anything not in the schema and continues — so a request setting a
         * field the API does not accept succeeds, and the client believes it
         * took effect. Posting `status: "active"` to registration and getting
         * a 201 back is exactly that failure: nothing went wrong visibly, and
         * the client's assumption is now wrong.
         *
         * Rejecting turns a silent misunderstanding into a 400 the caller can
         * act on. CI caught this: a test asserting rejection got a 201.
         */
        removeAdditional: false,
      },
    },
  });

  // First, so its hooks wrap every route below — including the ones added
  // later. Headers applied after a route is registered would still apply, but
  // the ordering makes "no response leaves this process without them" true by
  // construction rather than by remembering.
  registerSecurityHeaders(app);

  app.get("/health", () => {
    // Deliberately does not touch the database. This answers "is this process
    // alive and serving", which is what a liveness probe needs; a probe that
    // also checked Postgres would restart a healthy API during a brief
    // database blip, turning one outage into two. A readiness endpoint that
    // *does* check dependencies is a separate concern (Phase 18).
    return { status: "ok" };
  });

  // Registered outside the container check for the same reason `/health` is:
  // the disclosure channel describes the software, not a tenant's data, and a
  // researcher's scanner should find it on a process that has no database.
  registerSecurityTxtRoute(app);
  registerCspReportRoute(app);

  if (options.container !== undefined) {
    registerAuthRoutes(app, options.container);
  }

  return app;
}
