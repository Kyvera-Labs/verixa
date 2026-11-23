import { z } from "zod";

import { ConfigError } from "./config-error.js";
import { envSchema } from "./schema.js";

export { ConfigError } from "./config-error.js";
export {
  booleanFromEnv,
  corsConfigurationError,
  CORS_WILDCARD_ORIGIN,
  envSchema,
  getSchemaKeys,
  isValidCorsOrigin,
} from "./schema.js";
export { loadSigningKeys, SIGNING_KEY_ALGORITHMS, SIGNING_KEYS_ENV_VAR } from "./signing-keys.js";
export type { SigningKeyAlgorithm, SigningKeyConfig } from "./signing-keys.js";
export {
  DevSecretsSource,
  DotenvSecretsSource,
  InMemorySecretsSource,
  parseDotenv,
} from "./secrets-source.js";
export type { DotenvSecretsSourceOptions, SecretsSource } from "./secrets-source.js";

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
