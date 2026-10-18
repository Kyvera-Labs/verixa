import { z } from "zod";

import { ConfigError } from "./config-error.js";

export { ConfigError } from "./config-error.js";
export { loadSigningKeys, SIGNING_KEY_ALGORITHMS, SIGNING_KEYS_ENV_VAR } from "./signing-keys.js";
export type { SigningKeyAlgorithm, SigningKeyConfig } from "./signing-keys.js";

/**
 * A boolean read from an environment variable.
 *
 * `z.coerce.boolean()` is deliberately not used, because it is `Boolean(value)`
 * and every non-empty string is truthy — so `ENFORCE_HTTPS=false` would
 * *enable* the redirect. A flag whose most natural misconfiguration means its
 * own opposite is the worst kind to ship, so only the four spellings that
 * unambiguously state an answer parse, and anything else (`yes`, `TRUE`, an
 * empty value left by a half-filled `.env`) is a startup error listing the
 * variable by name.
 *
 * The `.default(...)` calls below are written in the *input* spelling —
 * `.default("true")`, not `.default(true)` — because a default is fed back
 * through the transform rather than returned as-is, so the boolean would never
 * typecheck and the string is what actually gets parsed.
 */
const booleanFromEnv = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1");

/**
 * The one wildcard a CORS allowlist accepts, spelled the way the Fetch spec
 * spells it.
 */
export const CORS_WILDCARD_ORIGIN = "*";

/**
 * A single origin entry the API is willing to reflect back in
 * `Access-Control-Allow-Origin`.
 *
 * `new URL(...)` plus an `origin` round-trip is deliberately stricter than
 * "looks like a URL": `https://app.example.com/path`, `https://app.example.com/`
 * and `HTTPS://APP.EXAMPLE.COM` all fail, and that is the point. The value is
 * matched character-for-character against the browser-sent `Origin` header, so
 * an entry that is merely *equivalent* to a real origin would silently never
 * match — a misconfiguration whose symptom is a blocked front end rather than
 * an error message. Rejecting it at startup turns that into a config failure.
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
 * The wildcard-with-credentials check, shared by the environment schema and the
 * CORS plugin.
 *
 * A browser refuses to store credentials from a response whose
 * `Access-Control-Allow-Origin` is `*`, so the pairing is either a no-op that
 * looks like it works or a front end that mysteriously cannot authenticate.
 * It is also an outright hole in the other direction when a proxy or a
 * framework "fixes" the wildcard by reflecting the caller's origin. Failing at
 * startup is the only honest outcome; returning the message means the schema
 * and the plugin cannot drift apart on what counts as invalid.
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

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().max(65535).default(3000),
    HOST: z.string().min(1).default("0.0.0.0"),
    LOG_LEVEL: z
      .enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"])
      .default("info"),
    // Not yet read by any repository (that starts with Issue 046) — present
    // now so it flows through the same validated, fail-fast config loading
    // as everything else, and so tooling like scripts/db-wait.mjs has one
    // canonical place to get it from instead of reading process.env directly.
    DATABASE_URL: z.string().url().default("postgres://verixa:verixa@localhost:5432/verixa"),

    /**
     * Maximum Postgres connections this process will hold open (Issue 053).
     *
     * Sizing formula: `pool size ≈ (peak concurrent requests that touch the
     * database) / (number of app instances)`, then round up modestly. It is
     * deliberately *not* "as high as the database allows."
     *
     * Raising this is the reflexive fix for connection-pool timeouts and
     * usually makes throughput worse. Every Postgres connection is a separate
     * OS process with its own memory (work_mem is per-operation, per-connection),
     * and past the point where active connections exceed available cores, they
     * compete for CPU and lock contention rather than doing more work — so
     * total throughput falls while every individual query gets slower. A pool
     * that is "too small" and briefly queues requests generally beats one that
     * lets a hundred connections thrash.
     *
     * Timeouts under load usually mean queries are too slow or held too long
     * (a transaction awaiting a network call, a missing index), and the pool is
     * just where the symptom appears. Fix the query before touching this.
     *
     * Capped at 100 because exceeding a stock Postgres `max_connections` (also
     * 100) means connection *errors*, not slowness — and the failure is far
     * more confusing than a queue. Multiple app instances share that budget:
     * ten instances at 20 each is 200, and the eleventh connection past the
     * limit fails outright.
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
     * HMAC key `@verixa/sessions`'s `JwtTokenSigner` signs and verifies access
     * tokens with (Issue 096).
     *
     * Unlike `DATABASE_URL`, this has **no default**. A database URL pointing
     * at the wrong (but real) database is a mistake you notice; a signing key
     * everyone's `.env.example` shares is a mistake you don't, because nothing
     * about a session issued with it looks wrong until someone who copied the
     * same public default forges one. Access tokens are bearer credentials —
     * see `docs/security/token-storage.md` on why those get no free passes on
     * secrecy just because a workflow is convenient. Every environment,
     * including local development, generates its own with e.g. `openssl rand
     * -base64 48`.
     *
     * 32 characters is a floor, not a target — it stops a trivially short
     * placeholder from validating, not a guarantee of adequate entropy on its
     * own. Phase 11 covers key management (rotation, storage) properly.
     */
    SESSION_ACCESS_TOKEN_SECRET: z
      .string()
      .min(32, "must be at least 32 characters — generate one with `openssl rand -base64 48`"),

    /**
     * Maximum simultaneous active sessions a single user may hold (Issue 094).
     * Logging in past this limit evicts the least-recently-active session —
     * see `IssueSession` in `@verixa/sessions`.
     *
     * `0` (the default) disables enforcement entirely, per that issue's own
     * acceptance criterion. Unlike `DATABASE_POOL_SIZE`, there is no safe
     * non-zero default to fall back to: a banking-style deployment might want
     * `1`, a consumer product might never want this on, and guessing wrong in
     * either direction is a product decision this package has no basis to
     * make on a deployment's behalf. Zero is the only default that cannot
     * surprise anyone who has not deliberately opted in.
     */
    SESSION_MAX_CONCURRENT_SESSIONS: z.coerce.number().int().min(0).default(0),

    // ---------------------------------------------------------------------------
    // Transport security — TLS enforcement & HSTS (Issue 213)
    //
    // `apps/api` maps these onto the `Strict-Transport-Security` directive and
    // the plaintext-redirect switch in `plugins/security-headers.ts`; the
    // reasoning for each default lives in `docs/security/tls-enforcement.md`.
    // They are validated here because this package is the only place `process.env`
    // is read: a header value that never went through validation is a header
    // value nobody checked was well-formed before it reached a browser.
    // ---------------------------------------------------------------------------

    /**
     * The `max-age` of the `Strict-Transport-Security` directive, in seconds.
     *
     * Only applied when `NODE_ENV=production` — pinning `localhost` for a year
     * is a way to lose an afternoon, and `securityHeadersFromConfig` in
     * `apps/api` explains the tradeoff.
     *
     * `0` is legal and means something specific: the header is still sent, with
     * `max-age=0`, which is how a browser is told to *drop* an existing pin.
     * Omitting the header instead would leave every visitor who saw the old one
     * pinned until their own max-age expired — the opposite of the emergency
     * exit someone sets this looking for.
     *
     * Capped at two years because the browser *renews* the pin on every response
     * carrying the header, so a very large `max-age` is a promise that outlives
     * the decision to make it.
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
     * Append `includeSubDomains` to the directive.
     *
     * The honest cost of turning this on is in the docs: every subdomain,
     * including the ones nobody controls and the ones that will exist later, has
     * to serve HTTPS or become unreachable for pinned visitors. Default on,
     * because the forgotten-certificate failure is the loud, fixable one, while
     * a stray wildcard record pointing at a plaintext host is the one that
     * nobody notices until a browser refuses to connect.
     */
    HSTS_INCLUDE_SUBDOMAINS: booleanFromEnv.default("true"),

    /**
     * Append `preload` to the directive.
     *
     * Off by default, deliberately. `preload` only means anything as part of a
     * submission to hstspreload.org, which ships the domain inside browsers'
     * source; the header alone does nothing. Its cost is near-irreversible —
     * removal is a multi-day request, and every subdomain has to be
     * HTTPS-capable *permanently*, including ones added years from now by
     * someone who never read this comment.
     *
     * Not defaulting it is the whole point: a flag with this much blast radius
     * should be a decision somebody types, not one a template inherits. Requires
     * `HSTS_INCLUDE_SUBDOMAINS` (the preload list rejects a directive without
     * it), checked at startup rather than discovered at submission time.
     */
    HSTS_PRELOAD: booleanFromEnv.default("false"),

    /**
     * Redirect plaintext requests to their HTTPS equivalent.
     *
     * Off by default because the safe owner of this redirect is usually not the
     * application: when a load balancer terminates TLS, the proxy already knows
     * the client's scheme and can answer in one round trip without involving
     * this process. Defaulting it on would break every deployment whose proxy
     * forgets to set `X-Forwarded-Proto` with an infinite redirect loop — a far
     * more common misconfiguration than a directly-exposed plaintext API. Enable
     * it when this process is the thing listening on port 80, or together with
     * `TRUST_PROXY`.
     */
    ENFORCE_HTTPS: booleanFromEnv.default("false"),

    /**
     * Honour `X-Forwarded-Proto` / `X-Forwarded-For` from the immediate upstream
     * proxy.
     *
     * Needed for `ENFORCE_HTTPS` to behave behind a TLS-terminating proxy, and
     * for anything that logs or rate-limits by client IP (Issue 209) to see the
     * client rather than the load balancer.
     *
     * Trusting these headers when there is no proxy lets a caller claim to be
     * anyone: `X-Forwarded-For: 1.2.3.4` slips past an IP blocklist, and
     * `X-Forwarded-Proto: https` skips the plaintext redirect. Off by default for
     * exactly that reason — it is a statement about network topology, and only
     * the operator knows it.
     */
    TRUST_PROXY: booleanFromEnv.default("false"),

    // ---------------------------------------------------------------------------
    // Cross-origin resource sharing — CORS policy (Issue 204)
    //
    // `apps/api` maps these onto `@fastify/cors` in `plugins/cors.ts`; the
    // reasoning for each default lives in `docs/security/cors-policy.md`.
    // ---------------------------------------------------------------------------

    /**
     * Comma-separated list of origins allowed to make browser requests.
     *
     * Empty by default, which denies every cross-origin browser client. That is
     * the safe default for an API: a deployment that has not thought about CORS
     * has no cross-origin front end to break, while one that has simply lists
     * its origins. Starting permissive and tightening later would mean every
     * client added in the meantime is a client the tightened policy breaks.
     *
     * A single `*` allows any origin and is legal **only** when
     * `CORS_ALLOW_CREDENTIALS=false` — the schema refuses the combination, as
     * does the plugin for callers that build the policy directly.
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
     * Send `Access-Control-Allow-Credentials` and allow cookies on cross-origin
     * requests.
     *
     * Off by default, and it should stay off unless a browser front end on a
     * *different* origin genuinely needs to carry the session cookie — which is
     * the rarer design. The API's bearer tokens travel in an `Authorization`
     * header, which CORS does not attach on its own, so a token-authenticated
     * cross-origin client does not need this at all.
     *
     * Refused in combination with the wildcard origin; see
     * {@link corsConfigurationError}.
     */
    CORS_ALLOW_CREDENTIALS: booleanFromEnv.default("false"),

    // ---------------------------------------------------------------------------
    // MFA enforcement — global defaults (Issue 114)
    //
    // These are the *global* defaults that apply when no org, role, or user
    // override is present. Individual orgs and users can raise or lower the bar
    // via runtime configuration stored in the database (not environment
    // variables), because per-tenant config cannot live in environment variables
    // — you would need one deployment per tenant if it did. The fields here give
    // operators a baseline that matches their deployment's security posture
    // without requiring every newly-created org to be individually configured.
    // ---------------------------------------------------------------------------

    /**
     * Global default MFA enforcement level (Issue 114).
     *
     * - `optional` (default): users may enroll but are not required to. A
     *   session is issued regardless. Safe for consumer-facing products where
     *   mandating MFA would cause friction before users understand the value.
     * - `required`: every user must complete an MFA challenge before a session
     *   is issued. Choose this for admin consoles, banking-style products, or
     *   any deployment where the threat model justifies the enrollment friction.
     * - `disabled`: MFA is blocked globally. Useful when authentication is
     *   delegated entirely to an external IdP that already enforces MFA and you
     *   do not want a second factor in Verixa itself.
     *
     * Per-org and per-user overrides take precedence over this value; see
     * `MfaEnforcementPolicy` in `packages/mfa`.
     */
    MFA_ENFORCEMENT_LEVEL: z.enum(["required", "optional", "disabled"]).default("optional"),

    /**
     * Comma-separated list of MFA method types permitted globally (Issue 114).
     *
     * Absent (empty string) means all types are permitted. Supply a list to
     * restrict: e.g. `MFA_ALLOWED_METHODS=totp,webauthn` to ban backup codes
     * org-wide when your security policy requires phishing-resistant factors.
     *
     * Valid values: `totp`, `webauthn`, `backup-codes`.
     *
     * The alternative — a separate boolean env var per method type — was
     * rejected because it scales poorly (N env vars for N methods, combinatorial
     * interactions) and cannot express "any subset of the three" cleanly.
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
  })
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
  });

/** The fully validated, immutable application configuration. */
export type Config = Readonly<z.infer<typeof envSchema>>;

/**
 * Validates `process.env` (or a supplied source, for testing) against the
 * application's configuration schema. Throws a {@link ConfigError} listing
 * every problem found, rather than letting an invalid or missing variable
 * surface later as a confusing runtime failure somewhere unrelated.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = envSchema.safeParse(env);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new ConfigError(`Invalid environment configuration:\n${details}`);
  }

  return Object.freeze(result.data);
}
