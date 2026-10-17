import { fileURLToPath } from "node:url";

import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { registerAdminAuthorizationRoutes } from "@verixa/authorization";
import { createLogger, type Logger } from "@verixa/shared-kernel";
import Fastify from "fastify";

import { registerContextRoutes } from "./composition/register-routes.js";
import type { Container } from "./composition-root.js";
import { errorResponseSchema, handleApiError } from "./http/error-response.js";
import { assertRouteValidationSchemas } from "./http/route-validation.js";
import { enforceRegisteredRouteSchemas } from "./openapi/zod-registry.js";
import { NO_CORS, registerCors, type CorsPolicy } from "./plugins/cors.js";
import {
  NO_TRANSPORT_SECURITY,
  registerSecurityHeaders,
  type HstsDirective,
  type SecurityHeadersOptions,
} from "./plugins/security-headers.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerVerificationRoutes } from "./routes/verification.js";

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
export type { CorsPolicy };

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
  /**
   * Transport-security response controls (Issue 213).
   *
   * Defaults to `NO_TRANSPORT_SECURITY` — no `Strict-Transport-Security`, no
   * plaintext redirect — for the same reason `container` is optional: the
   * callers that pass nothing are in-process tests, and `server.ts`, the only
   * caller that binds a port, always derives this from validated config.
   * Reading the environment here would put a second, unvalidated config path
   * next to `@verixa/config`, which is the thing this package exists to avoid.
   */
  readonly securityHeaders?: SecurityHeadersOptions;
  /**
   * The cross-origin browser policy (Issue 204).
   *
   * Defaults to `NO_CORS` — an empty allowlist — for the same reason
   * `securityHeaders` defaults to the nothing-on shape: the callers that pass
   * nothing are in-process tests, and `server.ts` always derives this from
   * validated configuration. Reading the environment here would create a
   * second, unvalidated config path.
   */
  readonly cors?: CorsPolicy;
  /**
   * Honour `X-Forwarded-Proto` / `X-Forwarded-For` from an upstream proxy.
   *
   * Off unless a deployment says it sits behind one. Trusting those headers
   * with no proxy in front is how a caller picks its own apparent IP and
   * scheme; see `docs/security/tls-enforcement.md`.
   */
  readonly trustProxy?: boolean;
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
    trustProxy: options.trustProxy ?? false,
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

  // Security headers are registered before any route exists, so "all routes
  // return the configured header set" is true by construction rather than by
  // every route remembering to ask (Issues 203 and 213). `/health` below is the
  // proof: it is the one endpoint a deployment is most likely to expose without
  // thinking about it.
  registerSecurityHeaders(app, options.securityHeaders ?? NO_TRANSPORT_SECURITY);
  registerCors(app, options.cors ?? NO_CORS);
  app.setErrorHandler(handleApiError);
  app.addSchema(errorResponseSchema);
  app.addHook("onRoute", (route) => assertRouteValidationSchemas(route));
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
      staticCSP: true,
      uiConfig: {
        docExpansion: "list",
        deepLinking: true,
        url: "/docs/openapi.json",
      },
    });
    app.get("/docs/openapi.json", () => app.swagger());
  }

  app.get("/health", () => {
    // Deliberately does not touch the database. This answers "is this process
    // alive and serving", which is what a liveness probe needs; a probe that
    // also checked Postgres would restart a healthy API during a brief
    // database blip, turning one outage into two. A readiness endpoint that
    // *does* check dependencies is a separate concern (Phase 18).
    return { status: "ok" };
  });

  if (options.container !== undefined) {
    enforceRegisteredRouteSchemas(app);
    registerAuthRoutes(app, options.container);
    registerAdminAuthorizationRoutes(app, options.container.authorization);
    // Takes only the Fastify instance: this route group resolves what it
    // needs from the request rather than from the container.
    registerVerificationRoutes(app);
    registerContextRoutes(app, options.container);
  }

  return app;
}
