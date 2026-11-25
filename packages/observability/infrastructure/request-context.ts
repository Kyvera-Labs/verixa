import { AsyncLocalStorage } from "node:async_hooks";

import { isSpanContextValid, trace } from "@opentelemetry/api";

/**
 * Immutable per-request context data carried across asynchronous boundaries.
 */
export interface RequestContextData {
  readonly correlationId: string;
  readonly traceId?: string | undefined;
  readonly actorId?: string | undefined;
  readonly route?: string | undefined;
  readonly [key: string]: unknown;
}

/**
 * AsyncLocalStorage instance managing the active per-request context.
 */
export const requestContextStorage = new AsyncLocalStorage<RequestContextData>();

/**
 * Runs a function within the scope of a given request context.
 *
 * All asynchronous operations started within `fn` (microtasks, timer callbacks,
 * database queries, outbound network requests) will inherit this context without
 * needing to thread it through function parameters.
 */
export function runWithRequestContext<T>(context: RequestContextData, fn: () => T): T {
  return requestContextStorage.run(context, fn);
}

/**
 * Retrieves the current request context, or undefined if called outside a request scope.
 * Safe to call anywhere; never throws.
 */
export function getRequestContext(): RequestContextData | undefined {
  return requestContextStorage.getStore();
}

/**
 * Returns the correlation ID for the active request, or undefined if outside request scope.
 */
export function getCorrelationId(): string | undefined {
  return requestContextStorage.getStore()?.correlationId;
}

/**
 * Returns the trace ID bound in the request context, or undefined if outside request scope.
 */
export function getTraceId(): string | undefined {
  return requestContextStorage.getStore()?.traceId;
}

/**
 * Resolves the effective active trace ID:
 * 1. Returns the trace ID from the request context if present.
 * 2. If absent or outside request context, extracts the trace ID from the active
 *    OpenTelemetry span (if valid).
 * 3. Returns undefined if neither is available.
 */
export function getActiveTraceId(): string | undefined {
  const contextTraceId = getTraceId();
  if (contextTraceId) {
    return contextTraceId;
  }

  const activeSpan = trace.getActiveSpan();
  if (activeSpan) {
    const spanContext = activeSpan.spanContext();
    if (isSpanContextValid(spanContext) && spanContext.traceId) {
      return spanContext.traceId;
    }
  }

  return undefined;
}

/**
 * Merges partial properties into the currently active request context.
 * If called outside an active request context, this is a safe no-op.
 */
export function bindRequestContext(updates: Partial<RequestContextData>): void {
  const store = requestContextStorage.getStore();
  if (!store) {
    return;
  }

  // Cast through mutable record to update fields in-place on the current store object
  const mutableStore = store as Record<string, unknown>;
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      mutableStore[key] = value;
    }
  }
}

/**
 * Clears the active request context for the current async flow.
 */
export function clearRequestContext(): void {
  requestContextStorage.disable();
}
