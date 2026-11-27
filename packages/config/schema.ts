import { z } from "zod";

/**
 * A boolean read from an environment variable. Not `z.coerce.boolean()`, which treats every
 * non-empty string as true, so `ENFORCE_HTTPS=false` would enable the redirect. Only `true`,
 * `false`, `1` and `0` parse; anything else fails at startup and names the variable.
 *
 * Defaults use `.prefault("true")` with the input spelling: in Zod 4, `.prefault()` runs the value
 * through the enum and transform, so an invalid default is still rejected.
 */
export const booleanFromEnv = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1");

/**
 * The one wildcard a CORS allowlist accepts, spelled the way the Fetch spec
 * spells it.
 */
export const CORS_WILDCARD_ORIGIN = "*";

/**
 * Supported OTLP transport protocols (Issue 356 / #468).
 *
 * Kept collector-agnostic so operators can target Jaeger, Grafana Tempo,
 * OpenTelemetry Collector, or any vendor OTLP endpoint without code changes.
 */
export const OTEL_EXPORTER_PROTOCOLS = ["http/protobuf", "http/json", "grpc"] as const;
export type OtelExporterProtocol = (typeof OTEL_EXPORTER_PROTOCOLS)[number];

/**
 * Default trace sampling rate per `NODE_ENV` when `OTEL_TRACES_SAMPLER_RATE` is unset:
 * `development` 1.0, `production` 0.1 (errors are always sampled), `test` 0.0.
 */
export const DEFAULT_OTEL_SAMPLING_RATES: Readonly<
  Record<"development" | "test" | "production", number>
> = Object.freeze({
  development: 1.0,
  test: 0.0,
  production: 0.1,
});

/**
 * Validates that an OTLP exporter endpoint is a well-formed `http:` or `https:`
 * URL with a non-empty host.
 */
export function isValidOtlpEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }

  return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0;
}

/**
 * Parses an OTel-standard comma-separated `key=value` header string into a
 * plain record. Returns `undefined` if any non-empty entry is malformed.
 */
export function parseOtlpHeaders(raw: string): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return headers;
  }

  for (const part of trimmed.split(",")) {
    const entry = part.trim();
    if (entry.length === 0) {
      return undefined;
    }
    const eqIndex = entry.indexOf("=");
    if (eqIndex <= 0) {
      return undefined;
    }
    const key = entry.slice(0, eqIndex).trim();
    const value = entry.slice(eqIndex + 1).trim();
    if (key.length === 0 || value.length === 0) {
      return undefined;
    }
    headers[key] = value;
  }

  return headers;
}

/**
 * Resolves the effective trace sampling rate for the given `NODE_ENV`.
 */
export function resolveOtelSamplingRate(
  nodeEnv: "development" | "test" | "production",
  configuredRate: number | undefined,
): number {
  return configuredRate ?? DEFAULT_OTEL_SAMPLING_RATES[nodeEnv];
}

/**
 * Whether an entry is a valid origin to reflect in `Access-Control-Allow-Origin`. It must equal its
 * own `URL.origin` exactly, because browsers send `Origin` in that exact form; an equivalent value
 * with a path, trailing slash or different case would never match, so it fails at startup instead.
 */
export function isValidCorsOrigin(origin: string): boolean {
  if (origin === CORS_WILDCARD_ORIGIN) {
    return true;
  }

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }

  return (url.protocol === "http:" || url.protocol === "https:") && url.origin === origin;
}

/**
 * Rejects a wildcard origin combined with credentials. Browsers refuse credentials when
 * `Access-Control-Allow-Origin` is `*`, and a proxy that "fixes" it by reflecting the origin opens
 * a hole. Shared by the environment schema and the CORS plugin so they cannot disagree.
 */
export function corsConfigurationError(
  allowedOrigins: readonly string[],
  allowCredentials: boolean,
): string | undefined {
  if (allowCredentials && allowedOrigins.includes(CORS_WILDCARD_ORIGIN)) {
    return (
      'CORS_ALLOW_CREDENTIALS=true cannot be combined with CORS_ALLOWED_ORIGINS="*". ' +
      "Browsers refuse credentialed responses whose Access-Control-Allow-Origin " +
      "is *, so this configuration can never do what it looks like it does. " +
      "List the concrete origins instead, or set CORS_ALLOW_CREDENTIALS=false."
    );
  }

  return undefined;
}

export const rawEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  HOST: z.string().min(1).default("0.0.0.0"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
  // Not yet read by any repository (that starts with Issue 046) — present
  // now so it flows through the same validated, fail-fast config loading
  // as everything else, and so tooling like scripts/db-wait.mjs has one
  // canonical place to get it from instead of reading process.env directly.
  DATABASE_URL: z.string().url().default("postgres://verixa:verixa@localhost:5432/verixa"),

  /**
   * Maximum Postgres connections this process holds open. Size it as peak concurrent database
   * requests divided by app instances, rounded up modestly, not as high as the database allows.
   *
   * Raising it rarely fixes pool timeouts: each connection is a separate Postgres process, and
   * beyond the available cores they compete for CPU and locks, so throughput falls. Timeouts under
   * load usually mean slow queries or connections held too long; fix those first.
   *
   * Capped at 100 to stay under a stock Postgres `max_connections`, which all app instances share;
   * exceeding it causes connection errors.
   */
  DATABASE_POOL_SIZE: z.coerce.number().int().positive().max(100).default(10),

  /**
   * Seconds to wait for a free connection before giving up.
   *
   * Bounded on purpose. Waiting indefinitely turns pool exhaustion into a
   * hang that looks like a dead process, and each waiting request keeps
   * holding memory and an inbound socket — so an unbounded queue converts a
   * slow database into a full outage. Failing fast sheds load and surfaces
   * the real problem.
   */
  DATABASE_POOL_TIMEOUT_SECONDS: z.coerce.number().int().positive().max(300).default(10),

  /**
   * Connection string for the revocation-list store used by
   * `@verixa/sessions`'s `RedisRevocationList` (Phase 05, Issue 096).
   *
   * Defaults to the instance `docker-compose.yml` provisions for local
   * development — same reasoning as `DATABASE_URL`'s default. Was already
   * documented in `.env.example` ahead of any code reading it; this is that
   * code.
   */
  REDIS_URL: z.string().url().default("redis://localhost:6379"),

  /**
   * HMAC key `JwtTokenSigner` uses to sign and verify access tokens. No default: a key shared
   * through `.env.example` would let anyone who copied it forge sessions. Generate one per
   * environment, for example with `openssl rand -base64 48` (see docs/security/token-storage.md).
   * The 32-character minimum only rejects obvious placeholders.
   */
  SESSION_ACCESS_TOKEN_SECRET: z
    .string()
    .min(32, "must be at least 32 characters — generate one with `openssl rand -base64 48`"),

  /**
   * Maximum simultaneous active sessions per user; logging in past it evicts the least recently
   * active session (see `IssueSession`). `0`, the default, disables the limit, since the right
   * value is a product decision.
   */
  SESSION_MAX_CONCURRENT_SESSIONS: z.coerce.number().int().min(0).default(0),

  // Transport security: TLS enforcement and HSTS. `apps/api` maps these onto
  // `plugins/security-headers.ts`; see docs/security/tls-enforcement.md for each default.

  /**
   * `max-age` of the `Strict-Transport-Security` header, in seconds. Applied only in production.
   * `0` is valid and sends `max-age=0`, which tells browsers to drop an existing pin. Capped at two
   * years because browsers renew the pin on every response.
   */
  HSTS_MAX_AGE_SECONDS: z.coerce
    .number()
    .int()
    .min(0)
    // Mirrors `MAX_HSTS_MAX_AGE_SECONDS` in apps/api's security-headers plugin.
    // The bound is repeated rather than imported because `apps/api` depends on
    // this package, and a config schema cannot reach up into an app.
    .max(63_072_000, "at most two years — see docs/security/tls-enforcement.md")
    .default(31_536_000),

  /**
   * Appends `includeSubDomains`. On by default; every subdomain must then serve HTTPS or become
   * unreachable for pinned visitors.
   */
  HSTS_INCLUDE_SUBDOMAINS: booleanFromEnv.prefault("true"),

  /**
   * Appends `preload`. Off by default: it only matters for an hstspreload.org submission, removal
   * takes a long time, and every future subdomain must serve HTTPS. Requires
   * `HSTS_INCLUDE_SUBDOMAINS`, checked at startup.
   */
  HSTS_PRELOAD: booleanFromEnv.prefault("false"),

  /**
   * Redirects plaintext requests to HTTPS. Off by default because a TLS-terminating load balancer
   * usually owns this, and a proxy that omits `X-Forwarded-Proto` would cause a redirect loop.
   * Enable it when this process listens on port 80, or together with `TRUST_PROXY`.
   */
  ENFORCE_HTTPS: booleanFromEnv.prefault("false"),

  /**
   * Trusts `X-Forwarded-Proto` and `X-Forwarded-For` from the immediate upstream proxy, which
   * `ENFORCE_HTTPS` and client-IP logging and rate limiting need behind a proxy. Off by default:
   * without a proxy, clients could spoof their IP or scheme.
   */
  TRUST_PROXY: booleanFromEnv.prefault("false"),

  // ---------------------------------------------------------------------------
  // Cross-origin resource sharing — CORS policy (Issue 204)
  //
  // `apps/api` maps these onto `@fastify/cors` in `plugins/cors.ts`; the
  // reasoning for each default lives in `docs/security/cors-policy.md`.
  // ---------------------------------------------------------------------------

  /**
   * Comma-separated origins allowed to make browser requests. Empty by default, denying all
   * cross-origin browser clients. A single `*` allows any origin and is only valid with
   * `CORS_ALLOW_CREDENTIALS=false`.
   */
  CORS_ALLOWED_ORIGINS: z
    .string()
    .default("")
    .transform((value) =>
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    )
    .pipe(
      z
        .array(
          z
            .string()
            .refine(
              isValidCorsOrigin,
              'must be an origin such as "https://app.example.com" (scheme, host, ' +
                "optional port — no path, no trailing slash) or the wildcard " +
                '"*"',
            ),
        )
        // A ceiling rather than a security control: it catches a pasted blob
        // of text that happens to parse as a thousand origins before the list
        // reaches every response header.
        .max(64),
    ),

  /**
   * Sends `Access-Control-Allow-Credentials`, allowing cookies on cross-origin requests. Only
   * needed when a front end on another origin must carry the session cookie; bearer tokens in the
   * `Authorization` header do not need it. Refused with the wildcard origin (see {@link
   * corsConfigurationError}).
   */
  CORS_ALLOW_CREDENTIALS: booleanFromEnv.prefault("false"),

  // MFA enforcement: global defaults used when no organization, role or user override exists.
  // Per-tenant overrides are stored in the database, not environment variables.

  /**
   * Global default MFA enforcement level:
   *
   * - `optional` (default): users may enroll; a session is issued either way.
   * - `required`: every user must complete an MFA challenge before a session is issued.
   * - `disabled`: MFA is blocked, for deployments whose external IdP already enforces it.
   *
   * Organization and user overrides take precedence (see `MfaEnforcementPolicy`).
   */
  MFA_ENFORCEMENT_LEVEL: z.enum(["required", "optional", "disabled"]).default("optional"),

  /**
   * Comma-separated MFA method types allowed globally: `totp`, `webauthn`, `backup-codes`. Empty
   * allows all; for example `totp,webauthn` disallows backup codes.
   */
  MFA_ALLOWED_METHODS: z
    .string()
    .optional()
    .transform((val) =>
      val
        ? val
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    ),

  // ---------------------------------------------------------------------------
  // OpenTelemetry OTLP exporter & sampling policy (Phase 18, Issue 356 / #468)
  // ---------------------------------------------------------------------------

  /**
   * Logical service name attached to emitted OpenTelemetry resource attributes.
   */
  OTEL_SERVICE_NAME: z.string().min(1).default("verixa-api"),
  /**
   * Serve Prometheus metrics at GET /metrics. Off by default: the endpoint is
   * unauthenticated and exposes route names, request volumes and error rates,
   * so it is enabled only where an (internal) scraper needs it.
   */
  METRICS_ENABLED: booleanFromEnv.prefault("false"),

  /**
   * Collector-agnostic OTLP exporter endpoint URL (e.g. `http://localhost:4318`
   * for HTTP or `http://localhost:4317` for gRPC).
   *
   * When omitted or empty, OTLP export is disabled so local development without
   * a running collector does not fail or spam connection errors. When provided,
   * an invalid URL or unsupported scheme fails fast at startup.
   */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z
      .string()
      .refine(
        isValidOtlpEndpoint,
        'must be a valid http:// or https:// URL (for example "http://localhost:4318")',
      )
      .optional(),
  ),

  /**
   * Transport protocol used by the OTLP exporter: `http/protobuf` (default),
   * `http/json`, or `grpc`.
   */
  OTEL_EXPORTER_OTLP_PROTOCOL: z.enum(OTEL_EXPORTER_PROTOCOLS).default("http/protobuf"),

  /**
   * Optional comma-separated `key=value` headers sent with OTLP export requests
   * (for example collector authentication tokens).
   */
  OTEL_EXPORTER_OTLP_HEADERS: z
    .string()
    .default("")
    .superRefine((raw, ctx) => {
      if (parseOtlpHeaders(raw) === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'must be a comma-separated list of "key=value" pairs (for example "Authorization=Bearer token")',
        });
      }
    })
    .transform((raw) => parseOtlpHeaders(raw) ?? {}),

  /**
   * Head-based probabilistic trace sampling rate in `[0, 1]`.
   *
   * When omitted or empty, defaults to `1.0` (100%) in `development`, `0.1`
   * (10%) in `production`, and `0.0` in `test`. Error spans are always
   * force-sampled regardless of this rate.
   */
  OTEL_TRACES_SAMPLER_RATE: z.preprocess(
    (value) => {
      if (value === undefined || (typeof value === "string" && value.trim() === "")) {
        return undefined;
      }
      return Number(value);
    },
    z
      .number({ error: "must be a number between 0 and 1" })
      .finite("must be a finite number between 0 and 1")
      .min(0, "must be between 0 and 1")
      .max(1, "must be between 0 and 1")
      .optional(),
  ),
});

export const envSchema = rawEnvSchema
  .superRefine((config, ctx) => {
    const error = corsConfigurationError(
      config.CORS_ALLOWED_ORIGINS,
      config.CORS_ALLOW_CREDENTIALS,
    );

    if (error !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["CORS_ALLOWED_ORIGINS"],
        message: error,
      });
    }
  })
  .transform((config) => ({
    ...config,
    OTEL_TRACES_SAMPLER_RATE: resolveOtelSamplingRate(
      config.NODE_ENV,
      config.OTEL_TRACES_SAMPLER_RATE,
    ),
  }));

/**
 * Rate limit policy configuration schema (Issue 284 / #315).
 * Validates per-route rate limit configuration with fail-fast Zod parsing.
 */
export const rateLimitPolicySchema = z.object({
  limit: z.coerce.number().int().positive("Limit must be positive"),
  windowMs: z.coerce.number().int().min(1000, "Window duration must be at least 1000ms"),
  capacity: z.coerce.number().positive().optional(),
  refillRatePerSecond: z.coerce.number().positive().optional(),
});

/**
 * Rate limit allowlist configuration schema (Issue 289 / #304).
 * Validates trusted IP addresses, CIDR blocks, and service-account tokens.
 */
export const rateLimitAllowlistSchema = z.object({
  ipAddressesOrCidrs: z.array(z.string().trim()).default([]),
  serviceTokens: z.array(z.string().trim()).default([]),
});

/**
 * Returns all environment variable keys defined in the configuration schema.
 */
export function getSchemaKeys(): readonly string[] {
  return Object.freeze(Object.keys(rawEnvSchema.shape));
}
