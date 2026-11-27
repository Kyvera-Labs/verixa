import cors from "@fastify/cors";
import {
  CORS_WILDCARD_ORIGIN,
  ConfigError,
  corsConfigurationError,
  type Config,
} from "@verixa/config";
import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";

/**
 * Who may call this API from a browser on another origin (Issue 204).
 *
 * CORS is the browser's escape hatch from the same-origin policy: the policy
 * stops a page at `evil.example` reading a response from this API, and a CORS
 * header is this API telling the browser to let a *named* other origin read
 * it. The whole security property therefore lives in the allowlist — a wide
 * one is the same as no same-origin policy at all.
 */
export interface CorsPolicy {
  /** Exact origins, or the single entry `"*"`. Empty means no cross-origin clients. */
  readonly allowedOrigins: readonly string[];
  readonly allowCredentials: boolean;
}

/**
 * The policy `buildApp` uses when the caller supplies none.
 *
 * Empty allowlist, no credentials. An empty list means every request carrying
 * an `Origin` header that this process did not itself emit is refused, which
 * is the honest default for an API whose only documented client is a
 * server-side integration: a deployment that has not configured CORS has no
 * cross-origin browser client to break.
 */
export const NO_CORS: CorsPolicy = {
  allowedOrigins: [],
  allowCredentials: false,
};

/**
 * The slice of validated configuration this module needs, named rather than
 * hand-copied: `Pick` makes a new CORS variable impossible to add without the
 * type checker pointing at this list.
 */
export type CorsConfig = Pick<Config, "CORS_ALLOWED_ORIGINS" | "CORS_ALLOW_CREDENTIALS">;

/**
 * Turns validated config into a CORS policy. Re-checks the wildcard-with-credentials combination
 * because tests and composition code can build a policy without `loadConfig`.
 */
export function corsPolicyFromConfig(config: CorsConfig): CorsPolicy {
  const conflict = corsConfigurationError(
    config.CORS_ALLOWED_ORIGINS,
    config.CORS_ALLOW_CREDENTIALS,
  );

  if (conflict !== undefined) {
    throw new ConfigError(`Invalid CORS configuration: ${conflict}`);
  }

  return {
    allowedOrigins: config.CORS_ALLOWED_ORIGINS,
    allowCredentials: config.CORS_ALLOW_CREDENTIALS,
  };
}

/**
 * Whether an `Origin` may read responses from this API. Exact string comparison only: suffix,
 * case-insensitive or regex matching is how `evil-app.example.com` ends up matching
 * `app.example.com`. `http` and `https` stay distinct.
 */
export function isOriginAllowed(origin: string, policy: CorsPolicy): boolean {
  return (
    policy.allowedOrigins.includes(CORS_WILDCARD_ORIGIN) || policy.allowedOrigins.includes(origin)
  );
}

/**
 * Registers the CORS policy before any route.
 *
 * 1. `@fastify/cors` answers preflights and adds `Access-Control-*` headers for allowed origins.
 * 2. An `onRequest` hook rejects any request carrying a disallowed `Origin`, so the request is
 *    never processed. Browsers would hide the response, but the server would otherwise still run
 *    it.
 *
 * Requests with no `Origin` (server-side clients, curl) are not cross-origin and pass through.
 * Generic over the logger because `buildApp`'s pino `Logger` is not structurally a
 * `FastifyBaseLogger`.
 */
export function registerCors<TLogger extends FastifyBaseLogger>(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression,
    RawReplyDefaultExpression,
    TLogger
  >,
  policy: CorsPolicy = NO_CORS,
): void {
  const conflict = corsConfigurationError(policy.allowedOrigins, policy.allowCredentials);

  if (conflict !== undefined) {
    throw new ConfigError(`Invalid CORS configuration: ${conflict}`);
  }

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;

    if (origin === undefined || isOriginAllowed(origin, policy)) {
      return;
    }

    // 403 rather than a bare response with no CORS headers: a client that
    // reads the status can tell "this origin is not allowed" from "this route
    // does not exist", and no body is reflected back to the caller.
    await reply.status(403).type("application/json").send({
      error: "forbidden_origin",
      message: "Origin is not allowed by this server's CORS policy.",
    });
  });

  if (policy.allowedOrigins.length === 0) {
    // Nothing to allow. The refusal hook above already rejects every
    // cross-origin request, and registering `@fastify/cors` only to have it
    // allow nothing would add an OPTIONS responder and a `Vary` header for no
    // behaviour.
    return;
  }

  app.register(cors, {
    /**
     * The literal `*` for a wildcard policy, otherwise a function using {@link isOriginAllowed}.
     * `@fastify/cors` reflects the request origin for a function, so a wildcard expressed that way
     * would send a specific origin instead of `*`.
     */
    origin: policy.allowedOrigins.includes(CORS_WILDCARD_ORIGIN)
      ? CORS_WILDCARD_ORIGIN
      : (origin, callback) => {
          // No Origin: a same-origin or non-browser request. Not a CORS
          // decision, so do not answer it as one.
          if (origin === undefined) {
            callback(null, true);
            return;
          }
          callback(null, isOriginAllowed(origin, policy));
        },
    credentials: policy.allowCredentials,
    // Reflect the request's `Origin` rather than sending `*`, so a future
    // wildcard-with-credentials edit cannot be masked by the array form's
    // serialization. With `credentials: true` a browser rejects `*` anyway.
    maxAge: 600,
  });
}
