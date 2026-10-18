import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from "fastify";
import mercurius from "mercurius";

import type { Container } from "../composition-root.js";

import { createIdentityLoaders, createIdentityResolvers } from "./resolvers/identity-resolvers.js";

// Both paths are fixed files in apps/api/graphql, reached the same way from
// src/ and dist/ (as with openapi/); nothing caller-supplied reaches them.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const rootSchema = readFileSync(
  fileURLToPath(new URL("../../graphql/root.graphql", import.meta.url)),
  "utf8",
);
// eslint-disable-next-line security/detect-non-literal-fs-filename
const identitySchema = readFileSync(
  fileURLToPath(new URL("../../graphql/identity.graphql", import.meta.url)),
  "utf8",
);

export const schema = `${rootSchema}\n${identitySchema}`;

const baseResolvers = {
  Query: {
    _service: () => "verixa-api",
  },
};

export interface RegisterGraphQLServerOptions {
  readonly container?: Container | undefined;
}

/**
 * Registers the Mercurius GraphQL server on the Fastify instance.
 *
 * Mounted at `/graphql`, sharing the Fastify server, logger, and correlation pipeline.
 * Field-level resolvers delegate directly to application use cases from the container,
 * maintaining the architectural rule that transport adapters contain no domain logic.
 */
export async function registerGraphQLServer<TLogger extends FastifyBaseLogger>(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression,
    RawReplyDefaultExpression,
    TLogger
  >,
  options: RegisterGraphQLServerOptions = {},
): Promise<void> {
  const container = options.container;

  const identityResolvers = container ? createIdentityResolvers(container) : undefined;
  const identityLoaders = container ? createIdentityLoaders(container) : undefined;

  const resolvers = identityResolvers
    ? {
        Query: {
          ...baseResolvers.Query,
          ...identityResolvers.Query,
        },
        Organization: identityResolvers.Organization,
        User: identityResolvers.User,
      }
    : baseResolvers;

  await app.register(mercurius, {
    schema,
    resolvers,
    ...(identityLoaders !== undefined ? { loaders: identityLoaders } : {}),
    graphiql: false,
    path: "/graphql",
  });
}

/**
 * Creates a standalone Fastify app with the GraphQL server registered.
 * Convenient for isolated integration testing and testing harness initialization.
 */
export async function createGraphQLApp(options: RegisterGraphQLServerOptions = {}) {
  const app = Fastify({ logger: false });
  await registerGraphQLServer(app, options);
  return app;
}
