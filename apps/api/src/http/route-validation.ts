interface RouteValidationShape {
  method: string | string[];
  url: string;
  schema?: {
    body?: unknown;
    params?: unknown;
    querystring?: unknown;
  };
}

/**
 * Write routes that legitimately have no request body to validate, keyed by `METHOD url` with the
 * full registered path including the group prefix. A key that never matches fails startup with
 * "missing validation schema(s)". Every entry needs a reason:
 *
 * - `POST /verification/:requestId/evidence` takes `multipart/form-data`, which the JSON body
 *   validator does not cover; the handler enforces the upload limit. Replace this entry with a real
 *   schema once `@fastify/multipart` is registered.
 * - `POST /verification/review-queue/claim` takes no body; its target comes from the authenticated
 *   principal.
 */
const BODY_SCHEMA_EXEMPTIONS = new Set([
  "POST /verification/:requestId/evidence",
  "POST /verification/review-queue/claim",
]);

/** Fail app registration when a route accepts input without a Fastify validator. */
export function assertRouteValidationSchemas(route: RouteValidationShape): void {
  const methods = (Array.isArray(route.method) ? route.method : [route.method]).map((method) =>
    method.toUpperCase(),
  );
  const schema = route.schema;
  const missing: string[] = [];

  if (route.url.includes(":") && schema?.params === undefined) missing.push("params");

  const carriesBody =
    methods.some((method) => ["POST", "PUT", "PATCH"].includes(method)) &&
    !methods.some((method) => BODY_SCHEMA_EXEMPTIONS.has(`${method} ${route.url}`));
  if (carriesBody && schema?.body === undefined) missing.push("body");

  if (
    methods.includes("GET") &&
    route.url === "/admin/users/:userId/roles" &&
    schema?.querystring === undefined
  ) {
    missing.push("querystring");
  }

  if (missing.length > 0) {
    throw new Error(
      `${methods.join(",")} ${route.url} is missing validation schema(s): ${missing.join(", ")}`,
    );
  }
}
