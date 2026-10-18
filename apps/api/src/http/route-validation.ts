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
 * Write routes that legitimately have no request body to validate.
 *
 * Matched on `METHOD url` using the URL as it is registered, which is exactly
 * what the `onRoute` hook reports — the full path with the route group's
 * prefix already applied (`/verification/...`), not the path as written inside
 * the module that declares it. Getting that wrong is silent in the dangerous
 * direction: an exemption keyed on a URL that never matches stops exempting
 * anything, and the route fails to register at startup with "missing
 * validation schema(s)". That is how this was caught, by the image smoke test
 * rather than by a unit test.
 *
 * An entry needs a reason, because "this route skips the validator" is the
 * kind of exception that otherwise gets copied:
 *
 * - `POST /verification/:requestId/evidence` takes `multipart/form-data`. Fastify's body
 *   validator applies to parsed JSON, so there is nothing to validate here;
 *   the handler enforces the upload limit itself. When `@fastify/multipart` is
 *   registered (Issue 168), the schema-less part will be the file stream, and
 *   the request fields — evidence type, checksum — will need a real schema
 *   added here and this entry removed.
 * - `POST /verification/review-queue/claim` is a claim action whose target
 *   comes from the authenticated principal, so it accepts no body at all.
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
