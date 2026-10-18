import { registerAdminAuthorizationRoutes } from "@verixa/authorization";
import type { RouteRegistration } from "@verixa/shared-kernel";
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyPluginAsync,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";

import type { Container } from "../composition-root.js";
import { registerAuditRoutes } from "../routes/audit.js";
import { registerAuthRoutes } from "../routes/auth.js";
import { registerVerificationRoutes } from "../routes/verification.js";

/**
 * Wires each context's transport adapter at its public URL prefix.
 *
 * Route modules translate HTTP to use cases; they do not construct adapters.
 * The concrete container comes from `buildContainer` and is closed over here,
 * once at startup, rather than looked up for every request.
 */
export function registerContextRoutes<TLogger extends FastifyBaseLogger>(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression,
    RawReplyDefaultExpression,
    TLogger
  >,
  container: Container,
): void {
  const registrations: readonly RouteRegistration<FastifyPluginAsync>[] = [
    {
      prefix: "/auth",
      plugin: async (scope) => registerAuthRoutes(scope, container),
    },
    {
      prefix: "/admin",
      plugin: async (scope) => registerAdminAuthorizationRoutes(scope, container.authorization),
    },
    {
      prefix: "/verification",
      plugin: async (scope) => registerVerificationRoutes(scope),
    },
    {
      prefix: "/audit",
      plugin: async (scope) => registerAuditRoutes(scope, container),
    },
  ];

  for (const registration of registrations) {
    app.register(registration.plugin, { prefix: registration.prefix });
  }
}
