import { DomainError, ValidationError } from "@verixa/shared-kernel";
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

import { API_ERROR_CODES, isApiErrorCode, type ApiErrorCode } from "./error-code-registry.js";

/**
 * The single response shape every error uses.
 *
 * Fixed deliberately. Clients that have to branch on the *shape* of an error
 * before they can read it end up with per-endpoint parsing, and the endpoint
 * that drifts is the one nobody notices until a client crashes on it.
 */
export interface ErrorResponseBody {
  readonly error: {
    /** Stable, machine-readable. Safe to branch on; `message` is not. */
    readonly code: string;
    /** Human-readable. May be reworded at any time without it being a breaking change. */
    readonly message: string;
    /** Structured, caller-safe context such as validation field failures. */
    readonly details?: Readonly<Record<string, unknown>>;
    readonly requestId: string;
  };
}

/** JSON Schema shared by route responses and the OpenAPI error component. */
export const errorResponseSchema = {
  $id: "ErrorResponse",
  type: "object",
  additionalProperties: false,
  required: ["error"],
  properties: {
    error: {
      type: "object",
      additionalProperties: false,
      required: ["code", "message", "requestId"],
      properties: {
        code: { type: "string", enum: Object.keys(API_ERROR_CODES) },
        message: { type: "string" },
        details: { type: "object", additionalProperties: true },
        requestId: { type: "string" },
      },
    },
  },
} as const;

type ValidationIssue = {
  instancePath?: string;
  message?: string;
  dataPath?: string;
  params?: Readonly<Record<string, unknown>>;
};
type ErrorWithValidation = FastifyError & {
  validation?: readonly ValidationIssue[];
  validationContext?: string;
};

export function sendApiError(
  reply: FastifyReply,
  code: ApiErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): void {
  const body: ErrorResponseBody = {
    error: {
      code,
      message,
      requestId: reply.request.id,
      ...(details === undefined ? {} : { details }),
    },
  };

  void reply.status(API_ERROR_CODES[code].status).send(body);
}

function validationDetails(error: ErrorWithValidation): Readonly<Record<string, unknown>> {
  const fields: Record<string, string[]> = {};
  for (const issue of error.validation ?? []) {
    const missingProperty = issue.params?.missingProperty;
    const property = typeof missingProperty === "string" ? `.${missingProperty}` : "";
    const path = `${error.validationContext ?? "request"}${issue.instancePath ?? issue.dataPath ?? ""}${property}`;
    (fields[path] ??= []).push(issue.message ?? "is invalid");
  }
  return { fields };
}

/** Converts Fastify and domain failures into the one public error contract. */
export function handleApiError(
  error: FastifyError,
  _request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (error instanceof DomainError) {
    if (!isApiErrorCode(error.code)) {
      sendUnexpectedError(reply, error);
      return;
    }

    const details =
      error instanceof ValidationError && Object.keys(error.fieldErrors).length > 0
        ? { fields: error.fieldErrors }
        : undefined;
    sendApiError(reply, error.code, error.message, details);
    return;
  }

  const fastifyError = error as ErrorWithValidation;
  if (error instanceof ZodError) {
    const fields: Record<string, string[]> = {};
    for (const issue of error.issues) {
      const path = issue.path.length > 0 ? issue.path.join(".") : "request";
      (fields[path] ??= []).push(issue.message);
    }
    sendApiError(reply, "VALIDATION_ERROR", "Request validation failed.", { fields });
    return;
  }

  if (fastifyError.validation !== undefined) {
    sendApiError(
      reply,
      "VALIDATION_ERROR",
      "Request validation failed.",
      validationDetails(fastifyError),
    );
    return;
  }

  if (error.statusCode === 404) {
    sendApiError(reply, "NOT_FOUND", "Route not found.");
    return;
  }

  if (error.statusCode === 400) {
    sendApiError(reply, "VALIDATION_ERROR", "Request could not be processed.");
    return;
  }

  const frameworkStatusCodes = {
    401: "AUTHENTICATION_FAILED",
    403: "FORBIDDEN",
    409: "CONFLICT",
    413: "PAYLOAD_TOO_LARGE",
    429: "RATE_LIMITED",
  } as const;
  if (error.statusCode !== undefined && error.statusCode in frameworkStatusCodes) {
    const code = frameworkStatusCodes[error.statusCode as keyof typeof frameworkStatusCodes];
    const messages = {
      AUTHENTICATION_FAILED: "Authentication failed.",
      FORBIDDEN: "Permission denied.",
      CONFLICT: "Request conflicts with the current resource state.",
      PAYLOAD_TOO_LARGE: "Request body is too large.",
      RATE_LIMITED: "Too many requests.",
    } as const;
    sendApiError(reply, code, messages[code]);
    return;
  }

  sendUnexpectedError(reply, error);
}

/**
 * Sends a domain error as an HTTP response.
 *
 * The status comes from the explicit API error registry, so routes do not
 * each maintain a switch mapping error classes to status codes — the classic
 * place where two endpoints quietly disagree about what a conflict is.
 *
 * Only `DomainError` subclasses reach here. Anything else is a bug or an
 * infrastructure failure, and is deliberately *not* translated: see
 * {@link sendUnexpectedError}.
 */
export function sendDomainError(reply: FastifyReply, error: DomainError): void {
  if (!isApiErrorCode(error.code)) {
    sendUnexpectedError(reply, error);
    return;
  }

  const details =
    error instanceof ValidationError && Object.keys(error.fieldErrors).length > 0
      ? { fields: error.fieldErrors }
      : undefined;
  sendApiError(reply, error.code, error.message, details);
}

/**
 * Sends a generic 500 for anything that is not a `DomainError`.
 *
 * The detail is logged, never returned. An unexpected failure is by
 * definition one nobody anticipated, so its message can contain anything — a
 * connection string, a SQL fragment naming a column, a stack trace exposing
 * paths. Returning it hands an attacker reconnaissance for free, and gives a
 * legitimate client nothing it can act on either.
 *
 * `DomainError` messages *are* returned, because those are written for
 * callers and say only what the caller already knows.
 */
export function sendUnexpectedError(reply: FastifyReply, error: unknown): void {
  reply.log.error({ err: error }, "unhandled error in request");
  sendApiError(reply, "INTERNAL_ERROR", "An unexpected error occurred.");
}

/** Routes `error` to the right handler based on whether it is a domain error. */
export function sendError(reply: FastifyReply, error: unknown): void {
  if (error instanceof DomainError) {
    sendDomainError(reply, error);
    return;
  }
  sendUnexpectedError(reply, error);
}
