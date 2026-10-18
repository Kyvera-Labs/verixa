import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
  RouteOptions,
} from "fastify";
import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

type OpenApiSchema = Record<string, unknown>;

// Keyed by `object` rather than `FastifyInstance`: the registry is generic over
// each app's concrete logger, and Fastify's instance types are not mutually
// assignable under `exactOptionalPropertyTypes`.
const schemasByApp = new WeakMap<object, Map<string, OpenApiSchema>>();

type App<TLogger extends FastifyBaseLogger> = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  TLogger
>;

function getOrCreateAppSchemas(app: FastifyInstance): Map<string, OpenApiSchema> {
  // Child scopes resolve to the root's map once `enforceRegisteredRouteSchemas`
  // has pointed them at it from its `onRegister` hook.
  const existing = schemasByApp.get(app);
  if (existing !== undefined) {
    return existing;
  }
  const created = new Map<string, OpenApiSchema>();
  schemasByApp.set(app, created);
  return created;
}

/** Register one Zod DTO as a reusable Fastify validator and OpenAPI component. */
export function registerZodSchema<TLogger extends FastifyBaseLogger, TSchema extends ZodTypeAny>(
  app: App<TLogger>,
  name: string,
  schema: TSchema,
): { $ref: string } {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid OpenAPI schema name: ${name}`);
  }

  // Fastify's `addSchema`/`getSchema` are declared on the default
  // `FastifyInstance` while this function is generic over the concrete logger
  // `buildApp` produces, and the two are not structurally assignable under
  // `exactOptionalPropertyTypes`. Narrowing here keeps the public signature
  // generic so callers can pass their own instance.
  const schemaHost = app as unknown as FastifyInstance;

  const appSchemas = getOrCreateAppSchemas(schemaHost);
  if (appSchemas.has(name) || schemaHost.getSchema(name) !== undefined) {
    throw new Error(`OpenAPI schema is already registered: ${name}`);
  }

  const jsonSchema = zodToJsonSchema(schema, {
    target: "openApi3",
    $refStrategy: "none",
  }) as OpenApiSchema;
  const component = { ...jsonSchema, $id: name };
  schemaHost.addSchema(component);
  appSchemas.set(name, component);
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
  const schemaHost = app as unknown as FastifyInstance;
  const rootSchemas = getOrCreateAppSchemas(schemaHost);
  // Routes are added inside encapsulated plugins (`/auth`, `/admin`,
  // `/verification`), each its own Fastify instance. Pointing every child at
  // the root map makes a schema registered in any scope visible to the check
  // below, whichever scope the route was added from.
  app.addHook("onRegister", (instance) => {
    schemasByApp.set(instance, rootSchemas);
  });

  // A regular function, not an arrow: Fastify binds `this` to the instance the
  // route is being added to. A schema added with `addSchema` inside a plugin is
  // visible to that plugin and its children only, so it must be looked up there
  // rather than on the root.
  app.addHook("onRoute", function (this: FastifyInstance, route: RouteOptions) {
    const schema = route.schema;
    if (schema === undefined) return;
    const method = Array.isArray(route.method) ? route.method.join(",") : route.method;
    for (const key of ["body", "params", "querystring"] as const) {
      const inputSchema = schema[key] as OpenApiSchema | undefined;
      if (inputSchema === undefined) continue;
      const ref = inputSchema.$ref;
      if (typeof ref !== "string" || !ref.endsWith("#")) {
        throw new Error(`${method} ${route.url} ${key} must use a registered Zod schema`);
      }
      const name = ref.slice(0, -1);
      if (!rootSchemas.has(name) && this.getSchema(name) === undefined) {
        throw new Error(`${method} ${route.url} ${key} references unregistered schema ${name}`);
      }
    }
  });
}
