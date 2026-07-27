// pino's CJS `export =` interop makes its default export appear to the linter as if it
// shadowed a named "pino" export that doesn't actually exist at the type level; this is
// the package's documented import style.
// eslint-disable-next-line import-x/no-named-as-default
import pino, { type Logger, type LoggerOptions, type DestinationStream } from "pino";

/**
 * Field-path patterns (pino's redact syntax) for values that must never
 * appear in logs in plaintext, no matter how deeply nested or under what
 * exact key name a caller happens to log them.
 */
const DEFAULT_REDACT_PATHS: readonly string[] = [
  "password",
  "*.password",
  "*.*.password",
  "token",
  "*.token",
  "*.*.token",
  "accessToken",
  "*.accessToken",
  "refreshToken",
  "*.refreshToken",
  "secret",
  "*.secret",
  "apiKey",
  "*.apiKey",
  "authorization",
  "*.authorization",
  "req.headers.authorization",
  "res.headers.authorization",
  "req.headers.cookie",
  "res.headers['set-cookie']",
];

export interface CreateLoggerOptions {
  /** Minimum level to emit, e.g. "info". Defaults to "info". */
  level?: string;
  /** Included in every log line to identify which process/service emitted it. */
  name?: string;
  /** Additional redact paths, appended to the built-in sensitive-field list. */
  redact?: readonly string[];
}

/**
 * Creates a pino logger with structured JSON output and redaction of common
 * sensitive fields pre-configured. Callers can further scope it per request
 * via the standard pino `.child({ ... })` API (this is exactly what Fastify
 * does automatically when the logger is passed via `loggerInstance`).
 */
export function createLogger(
  options: CreateLoggerOptions = {},
  destination?: DestinationStream,
): Logger {
  const pinoOptions: LoggerOptions = {
    level: options.level ?? "info",
    redact: {
      paths: [...DEFAULT_REDACT_PATHS, ...(options.redact ?? [])],
      censor: "[REDACTED]",
    },
  };

  if (options.name !== undefined) {
    pinoOptions.name = options.name;
  }

  return destination ? pino(pinoOptions, destination) : pino(pinoOptions);
}

export type { Logger };
