import { registerAdminAuthorizationRoutes } from "@verixa/authorization";
import type { RouteRegistration } from "@verixa/shared-kernel";
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyPluginCallback,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";

import type { Container } from "../composition-root.js";
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
  // Callbacks rather than `async` functions: these registrations only declare
  // routes and never await, and an `async` wrapper would add a promise nobody
  // consumes for the sole benefit of matching the plugin type.
  const registrations: readonly RouteRegistration<FastifyPluginCallback>[] = [
    {
      prefix: "/auth",
      plugin: (scope) => {
        registerAuthRoutes(scope, container);
      },
    },
    {
      prefix: "/admin",
      plugin: (scope) => {
        registerAdminAuthorizationRoutes(scope, container.authorization);
      },
    },
    {
      prefix: "/verification",
      plugin: (scope) => {
        registerVerificationRoutes(scope);
      },
    },
  ];

  for (const registration of registrations) {
    app.register(registration.plugin, { prefix: registration.prefix });
  }
}
