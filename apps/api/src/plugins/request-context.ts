import { randomUUID } from "node:crypto";

import { getActiveTraceId, runWithRequestContext } from "@verixa/observability";
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  FastifyTypeProvider,
  FastifyTypeProviderDefault,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerBase,
  RawServerDefault,
} from "fastify";

export const REQUEST_ID_HEADER = "x-request-id";
export const TRACE_ID_HEADER = "x-trace-id";

declare module "fastify" {
  interface FastifyRequest {
    requestId: string;
    traceId?: string;
  }
}

export interface RequestContextOptions {
  headerName?: string;
  generateId?: () => string;
}

/**
 * Extracts the trace ID from a W3C traceparent header:
 * Format: {version}-{trace_id}-{parent_id}-{trace_flags}
 * Example: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
 */
function parseTraceParent(header: unknown): string | undefined {
  if (typeof header !== "string") return undefined;
  const parts = header.trim().split("-");
  if (parts.length >= 4 && parts[1]?.length === 32) {
    return parts[1];
  }
  return undefined;
}

/**
 * Request context, correlation ID, and distributed OpenTelemetry trace ID linkage plugin.
 *
 * 1. Checks for an inbound `X-Request-Id` (or configured header). If valid, preserves it; otherwise generates a UUID v4.
 * 2. Extracts or detects the OpenTelemetry trace ID (from active span, traceparent header, or x-trace-id header).
 * 3. Binds correlation ID and trace ID into the AsyncLocalStorage RequestContext foundation.
 * 4. Echoes `X-Request-Id` and `X-Trace-Id` on outgoing response headers.
 * 5. Binds `requestId` and `traceId` to the child logger context so every log line is navigable across pillars.
 */
export function registerRequestContext<
  Server extends RawServerBase = RawServerDefault,
  Request extends RawRequestDefaultExpression<Server> = RawRequestDefaultExpression<Server>,
  Reply extends RawReplyDefaultExpression<Server> = RawReplyDefaultExpression<Server>,
  Logger extends FastifyBaseLogger = FastifyBaseLogger,
  TypeProvider extends FastifyTypeProvider = FastifyTypeProviderDefault,
>(
  app: FastifyInstance<Server, Request, Reply, Logger, TypeProvider>,
  options: RequestContextOptions = {},
): void {
  const headerName = (options.headerName ?? REQUEST_ID_HEADER).toLowerCase();
  const generateId = options.generateId ?? randomUUID;

  app.addHook("onRequest", (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
    const rawInboundId = request.headers[headerName];
    const requestId =
      typeof rawInboundId === "string" && rawInboundId.trim().length > 0
        ? rawInboundId.trim()
        : generateId();

    // Extract traceId from inbound headers or active OpenTelemetry span
    const inboundTraceId =
      (typeof request.headers[TRACE_ID_HEADER] === "string" &&
        request.headers[TRACE_ID_HEADER].trim()) ||
      parseTraceParent(request.headers["traceparent"]) ||
      getActiveTraceId();

    const traceId = inboundTraceId || undefined;

    // Assign to Fastify request object
    request.id = requestId;
    request.requestId = requestId;
    if (traceId) {
      request.traceId = traceId;
    }

    // Echo correlation ID and trace ID in response headers
    reply.header(headerName, requestId);
    if (traceId) {
      reply.header(TRACE_ID_HEADER, traceId);
    }

    // Attach requestId and traceId to child logger context
    if (typeof request.log?.child === "function") {
      request.log = request.log.child({
        reqId: requestId,
        requestId,
        ...(traceId ? { traceId } : {}),
      });
    }

    // Run remaining request lifecycle within RequestContext AsyncLocalStorage
    runWithRequestContext(
      {
        correlationId: requestId,
        ...(traceId ? { traceId } : {}),
        route: request.url,
      },
      () => {
        done();
      },
    );
  });
}

/**
 * Helper to build outbound request headers containing correlation and distributed trace tracking.
 */
export function propagateRequestContext(
  request: FastifyRequest,
  headers: Record<string, string> = {},
): Record<string, string> {
  const id = request.requestId || request.id;
  const traceId = request.traceId;
  const result: Record<string, string> = { ...headers };

  if (id) {
    result[REQUEST_ID_HEADER] = id;
  }
  if (traceId) {
    result[TRACE_ID_HEADER] = traceId;
  }

  return result;
}

export default registerRequestContext;
