import cors, { type FastifyCorsOptions } from "@fastify/cors";
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

export interface CorsConfig {
  readonly allowedOrigins: readonly string[];
  readonly allowCredentials?: boolean;
}

export const DEFAULT_DEV_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:5173",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5173",
];

export const DEFAULT_PROD_ORIGINS = ["https://app.verixa.io", "https://api.verixa.io"];

export function getCorsOptions(config?: Partial<CorsConfig>): FastifyCorsOptions {
  const nodeEnv = process.env["NODE_ENV"] ?? "development";
  const defaultOrigins = nodeEnv === "production" ? DEFAULT_PROD_ORIGINS : DEFAULT_DEV_ORIGINS;
  const allowedOrigins = config?.allowedOrigins ?? defaultOrigins;
  const allowCredentials = config?.allowCredentials ?? true;

  return {
    origin: (origin, cb) => {
      // Allow requests with no origin (like mobile apps, curl, or same-origin server requests)
      if (!origin) {
        cb(null, true);
        return;
      }

      if (allowedOrigins.includes(origin)) {
        cb(null, true);
        return;
      }

      // Explicitly reject non-allow-listed origins
      cb(new Error("Not allowed by CORS"), false);
    },
    credentials: allowCredentials,
    methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Origin",
      "X-Requested-With",
      "Content-Type",
      "Accept",
      "Authorization",
      "X-Request-Id",
      "X-Api-Key",
      "Idempotency-Key",
    ],
    exposedHeaders: [
      "X-Request-Id",
      "X-RateLimit-Limit",
      "X-RateLimit-Remaining",
      "X-RateLimit-Reset",
      "Retry-After",
    ],
    maxAge: 86400,
  };
}

export function registerCors<TLogger extends FastifyBaseLogger = FastifyBaseLogger>(
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
 * Turn validated config into a policy, re-checking the one combination the
 * environment schema already refuses.
 *
 * The duplicate check is not defensive noise. `loadConfig` is not the only
 * caller: tests and future composition code construct a `CorsPolicy` directly,
 * and the wildcard-plus-credentials pairing is exactly the mistake someone
 * makes by hand. Failing here means it fails in one place, before a request is
 * ever answered, rather than as a browser silently refusing to store the
 * session cookie.
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
 * Whether an `Origin` header value may read responses from this API.
 *
 * Exact string comparison, deliberately: the `Origin` header a browser sends
 * is a serialized origin (`scheme://host[:port]`, lower-cased, no path), and
 * anything looser — a suffix match, a case-insensitive compare, a regex a
 * contributor writes once — is how `evil-app.example.com` ends up matching
 * `app.example.com`. `http` and `https` are distinct origins under the
 * same-origin policy, and this function keeps them distinct.
 */
export function isOriginAllowed(origin: string, policy: CorsPolicy): boolean {
  return (
    policy.allowedOrigins.includes(CORS_WILDCARD_ORIGIN) || policy.allowedOrigins.includes(origin)
  );
}

/**
 * Register the CORS policy on `app`.
 *
 * Registered before any route, like the security headers, so coverage is a
 * property of the instance rather than something each route opts into.
 *
 * Two layers, and the second is the one that satisfies "requests from
 * non-allowlisted origins are rejected":
 *
 * 1. `@fastify/cors` answers preflight requests and decorates responses with
 *    the `Access-Control-*` headers for origins the policy allows. This is
 *    what the browser consults, and it is invisible to a non-browser client.
 * 2. An `onRequest` hook refuses any request that carries an `Origin` this
 *    policy does not allow. Without it, a disallowed origin would still get
 *    the full response body — the browser would refuse to show it, but the
 *    request would have been processed, which is not the same as rejected. A
 *    server-side caller can set any `Origin` it likes, so the second layer is
 *    also what stops the header being treated as an access-control decision.
 *
 * A request with no `Origin` at all (server-side clients, curl, same-origin
 * navigations that some browsers omit it from) is not a cross-origin request
 * and is left alone; refusing it would break every non-browser client for a
 * browser-only policy.
 *
 * Generic over the logger for the same reason `registerAuthRoutes` is: the
 * instance `buildApp` produces carries a concrete pino `Logger`, which is not
 * structurally identical to Fastify's `FastifyBaseLogger`.
 */
export function registerCors<TLogger extends FastifyBaseLogger>(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression,
    RawReplyDefaultExpression,
    TLogger
  >,
  config?: Partial<CorsConfig>,
): void {
  app.register(cors, getCorsOptions(config));
}

export default registerCors;
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
     * The literal `*` when the policy says wildcard, and a function that
     * performs the explicit {@link isOriginAllowed} comparison otherwise.
     *
     * The distinction is not cosmetic: `@fastify/cors` reflects the request's
     * origin whenever `origin` is a function, so a wildcard policy expressed
     * as a callback would send a specific origin rather than `*`. That is a
     * different header to a shared cache and to any reviewer who reads the
     * config, and it hides the wildcard from the one check that is supposed
     * to refuse it next to credentials.
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
