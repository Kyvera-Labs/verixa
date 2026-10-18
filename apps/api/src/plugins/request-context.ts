import { randomUUID } from "node:crypto";
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";

export const REQUEST_ID_HEADER = "x-request-id";

declare module "fastify" {
  interface FastifyRequest {
    requestId: string;
  }
}

export interface RequestContextOptions {
  headerName?: string;
  generateId?: () => string;
}

/**
 * Request context and correlation ID propagation plugin.
 *
 * 1. Checks for an inbound `X-Request-Id` (or configured header). If present, preserves it.
 * 2. If absent, generates a new UUID v4.
 * 3. Sets `request.id` and `request.requestId` to ensure consistency.
 * 4. Echoes `X-Request-Id` on the outgoing response.
 * 5. Binds `requestId` to the child logger context for the lifetime of the request.
 */
export function registerRequestContext<TLogger extends FastifyBaseLogger = FastifyBaseLogger>(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression,
    RawReplyDefaultExpression,
    TLogger
  >,
  options: RequestContextOptions = {},
): void {
  const headerName = (options.headerName ?? REQUEST_ID_HEADER).toLowerCase();
  const generateId = options.generateId ?? randomUUID;

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const rawInboundId = request.headers[headerName];
    const requestId =
      typeof rawInboundId === "string" && rawInboundId.trim().length > 0
        ? rawInboundId.trim()
        : generateId();

    // Assign to request context
    request.id = requestId;
    request.requestId = requestId;

    // Echo correlation ID header in the response
    reply.header(headerName, requestId);

    // Attach requestId to request logger child context if logger has child method
    if (typeof request.log?.child === "function") {
      request.log = request.log.child({ reqId: requestId, requestId });
    }
  });
}

/**
 * Helper to build outbound request headers containing correlation tracking.
 */
export function propagateRequestContext(
  request: FastifyRequest,
  headers: Record<string, string> = {},
): Record<string, string> {
  const id = request.requestId || request.id;
  if (!id) return headers;
  return {
    ...headers,
    [REQUEST_ID_HEADER]: id,
  };
}

export default registerRequestContext;
