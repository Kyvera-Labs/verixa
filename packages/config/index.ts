import { z } from "zod";

const envSchema = z.object({
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
});

/** The fully validated, immutable application configuration. */
export type Config = Readonly<z.infer<typeof envSchema>>;

/** Thrown by {@link loadConfig} when required environment variables are missing or invalid. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

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
