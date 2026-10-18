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

  const appSchemas = schemasByApp.get(app) ?? new Map<string, OpenApiSchema>();
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
  // A regular function with an explicit `this`, not an arrow: Fastify invokes
  // the hook with `this` bound to the instance the route is being added to,
  // and routes are added inside encapsulated plugins (`/auth`, `/admin`,
  // `/verification`), where the schema was registered on that same scope.
  // Checking the root `app`'s registry instead would reject every prefixed
  // route as "referencing an unregistered schema" — the schemas are visible to
  // the child context that registered them and to no other.
  app.addHook("onRoute", function (this: FastifyInstance, route: RouteOptions) {
    // Routes that predate this registry declare hand-written JSON Schema and
    // opt out with `config.allowJsonSchemaValidation`; see the RBAC route
    // module. The exemption is a per-route marker rather than a URL prefix so
    // it stays visible at the route that needs it.
    const routeConfig = route.config as { allowJsonSchemaValidation?: boolean } | undefined;
    if (routeConfig?.allowJsonSchemaValidation === true) return;

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
      if (!schemasByApp.get(this)?.has(name)) {
        throw new Error(`${method} ${route.url} ${key} references unregistered schema ${name}`);
      }
    }
  });
}
