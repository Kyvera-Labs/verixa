import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";
import mercurius from "mercurius";

const schema = `
  type Query {
    _service: String!
  }
`;

const resolvers = {
  Query: {
    _service: () => "verixa-api",
  },
};

/**
 * Registers Mercurius GraphQL server on the Fastify instance.
 *
 * Mounted at `/graphql` sharing the Fastify server, logger, and correlation pipeline.
 */
export async function registerGraphQLServer<TLogger extends FastifyBaseLogger>(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression,
    RawReplyDefaultExpression,
    TLogger
  >,
): Promise<void> {
  await app.register(mercurius, {
    schema,
    resolvers,
    graphiql: false,
    path: "/graphql",
  });
}
