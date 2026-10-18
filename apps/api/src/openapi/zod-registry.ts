import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
  RouteOptions,
} from "fastify";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny } from "zod";

type OpenApiSchema = Record<string, unknown>;

const schemasByApp = new WeakMap<FastifyInstance, Map<string, OpenApiSchema>>();

type App<TLogger extends FastifyBaseLogger> = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  TLogger
>;

/** Register one Zod DTO as a reusable Fastify validator and OpenAPI component. */
export function registerZodSchema<TLogger extends FastifyBaseLogger, TSchema extends ZodTypeAny>(
  app: App<TLogger>,
  name: string,
  schema: TSchema,
): { $ref: string } {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid OpenAPI schema name: ${name}`);
  }

  const appSchemas = schemasByApp.get(app) ?? new Map<string, OpenApiSchema>();
  if (appSchemas.has(name) || app.getSchema(name) !== undefined) {
    throw new Error(`OpenAPI schema is already registered: ${name}`);
  }

  const jsonSchema = zodToJsonSchema(schema, {
    target: "openApi3",
    $refStrategy: "none",
  }) as OpenApiSchema;
  const component = { ...jsonSchema, $id: name };
  app.addSchema(component);
  appSchemas.set(name, component);
  schemasByApp.set(app, appSchemas);
  return { $ref: `${name}#` };
}

/** Return the OpenAPI components generated from the same schemas Fastify validates. */
export function getOpenApiComponents(app: FastifyInstance): {
  schemas: Record<string, OpenApiSchema>;
} {
  return { schemas: Object.fromEntries(schemasByApp.get(app) ?? []) };
}

/** Reject inline route input schemas so they cannot drift away from OpenAPI. */
export function enforceRegisteredRouteSchemas<TLogger extends FastifyBaseLogger>(
  app: App<TLogger>,
): void {
  app.addHook("onRoute", (route: RouteOptions) => {
    const schema = route.schema;
    if (schema === undefined) return;
    for (const key of ["body", "params", "querystring"] as const) {
      const inputSchema = schema[key] as OpenApiSchema | undefined;
      if (inputSchema === undefined) continue;
      const ref = inputSchema.$ref;
      if (typeof ref !== "string" || !ref.endsWith("#")) {
        throw new Error(`${route.method} ${route.url} ${key} must use a registered Zod schema`);
      }
      const name = ref.slice(0, -1);
      if (!schemasByApp.get(app)?.has(name)) {
        throw new Error(
          `${route.method} ${route.url} ${key} references unregistered schema ${name}`,
        );
      }
    }
  });
}
