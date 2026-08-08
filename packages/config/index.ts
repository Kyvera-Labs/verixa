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
