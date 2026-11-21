// pino's CJS export interop
// eslint-disable-next-line import-x/no-named-as-default
import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";

import { getActiveTraceId, getRequestContext } from "./request-context.js";

/**
 * Standard sensitive field patterns that must be censored in structured logs.
 */
export const DEFAULT_REDACT_PATHS: readonly string[] = [
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

export interface ContextualLoggerOptions {
  /** Minimum log level to emit; defaults to "info". */
  readonly level?: string;
  /** Process/service component name included on every log line. */
  readonly name?: string;
  /** Additional field paths to redact beyond the standard security baseline. */
  readonly redact?: readonly string[];
  /** Optional custom mixin callback that can add custom attributes. */
  readonly mixin?: (context: object, level: number) => object;
}

/**
 * Creates a structured JSON Pino logger pre-configured with:
 * 1. Automatic contextual bindings (correlationId, traceId, req.id, trace.id, actor.id, route)
 *    injected seamlessly from the active RequestContext and OpenTelemetry active span.
 * 2. Standardized field taxonomy adhering to Phase 18 specifications.
 * 3. Robust redaction of credential and authentication secrets.
 */
export function createContextualLogger(
  options: ContextualLoggerOptions = {},
  destination?: DestinationStream,
): Logger {
  const pinoOptions: LoggerOptions = {
    level: options.level ?? "info",
    redact: {
      paths: [...DEFAULT_REDACT_PATHS, ...(options.redact ?? [])],
      censor: "[REDACTED]",
    },
    mixin(context: object, level: number) {
      const reqContext = getRequestContext();
      const activeTraceId = reqContext?.traceId ?? getActiveTraceId();

      const bindings: Record<string, unknown> = {};

      if (reqContext?.correlationId) {
        bindings.correlationId = reqContext.correlationId;
        bindings["req.id"] = reqContext.correlationId;
      }

      if (activeTraceId) {
        bindings.traceId = activeTraceId;
        bindings["trace.id"] = activeTraceId;
      }

      if (reqContext?.actorId) {
        bindings.actorId = reqContext.actorId;
        bindings["actor.id"] = reqContext.actorId;
      }

      if (reqContext?.route) {
        bindings.route = reqContext.route;
      }

      const customBindings = options.mixin ? options.mixin(context, level) : {};
      return { ...bindings, ...customBindings };
    },
  };

  if (options.name !== undefined) {
    pinoOptions.name = options.name;
  }

  return destination ? pino(pinoOptions, destination) : pino(pinoOptions);
}

export type { Logger };
