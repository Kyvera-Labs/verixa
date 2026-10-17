interface RouteValidationShape {
  method: string | string[];
  url: string;
  schema?: {
    body?: unknown;
    params?: unknown;
    querystring?: unknown;
  };
}

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
    route.url !== "/verification/review-queue/claim" &&
    route.url !== "/verification/:requestId/evidence";
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
