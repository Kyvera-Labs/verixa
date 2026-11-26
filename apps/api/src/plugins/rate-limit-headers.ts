import type { RateLimitKey, RateLimiter, RateLimitResult } from "@verixa/shared-kernel";
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";

import { sendApiError } from "../http/error-response.js";

/**
 * Standard HTTP rate-limit response headers.
 * Uses the widely supported de facto standard X-RateLimit-* headers along with RFC 9110 Retry-After.
 */
export const RATE_LIMIT_HEADERS = {
  LIMIT: "X-RateLimit-Limit",
  REMAINING: "X-RateLimit-Remaining",
  RESET: "X-RateLimit-Reset",
  RETRY_AFTER: "Retry-After",
} as const;

/**
 * Calculates retry-after in seconds given the bucket reset timestamp in milliseconds.
 * Enforces a minimum floor of 1 second per RFC 9110 / 6585 to prevent immediate spin-retries.
 */
export function calculateRetryAfterSeconds(resetAtMs: number, nowMs: number = Date.now()): number {
  const diffMs = resetAtMs - nowMs;
  return Math.max(1, Math.ceil(diffMs / 1000));
}

/**
 * Sets standard rate-limiting headers on a Fastify reply derived from a consulted RateLimitResult.
 *
 * Headers added:
 * - X-RateLimit-Limit: Total request quota allowed within the active window.
 * - X-RateLimit-Remaining: Number of remaining allowed requests within the active window.
 * - X-RateLimit-Reset: Unix timestamp in integer epoch seconds when the quota resets.
 * - Retry-After: Present only on denied (429) responses, indicating seconds until quota resets.
 */
export function applyRateLimitHeaders(
  reply: FastifyReply,
  result: RateLimitResult,
  nowMs: number = Date.now(),
): void {
  reply.header(RATE_LIMIT_HEADERS.LIMIT, result.limit.toString());
  reply.header(RATE_LIMIT_HEADERS.REMAINING, Math.max(0, result.remaining).toString());
  reply.header(RATE_LIMIT_HEADERS.RESET, Math.ceil(result.resetAt / 1000).toString());

  if (!result.allowed) {
    const retryAfter = calculateRetryAfterSeconds(result.resetAt, nowMs);
    reply.header(RATE_LIMIT_HEADERS.RETRY_AFTER, retryAfter.toString());
  }
}

declare module "fastify" {
  interface FastifyContextConfig {
    rateLimit?: {
      action?: RateLimitKey["action"];
      identifier?: (request: FastifyRequest) => string;
      namespace?: string;
      limiter?: RateLimiter;
      max?: number;
      timeWindowMs?: number;
    };
  }
  interface FastifyRequest {
    rateLimitResult?: RateLimitResult;
  }
  interface FastifyReply {
    setRateLimitHeaders(result: RateLimitResult, nowMs?: number): this;
  }
}

export interface RateLimitHeadersOptions {
  rateLimiter?: RateLimiter;
  defaultAction?: RateLimitKey["action"];
  keyResolver?: (request: FastifyRequest) => RateLimitKey | Promise<RateLimitKey>;
  now?: () => number;
}

/**
 * Registers rate-limiting header decorators and route hooks on a Fastify instance.
 */
export function registerRateLimitHeaders<TLogger extends FastifyBaseLogger = FastifyBaseLogger>(
  fastify: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression,
    RawReplyDefaultExpression,
    TLogger
  >,
  options: RateLimitHeadersOptions = {},
): void {
  const defaultAction = options.defaultAction ?? "login";
  const now = options.now ?? (() => Date.now());

  if (!fastify.hasReplyDecorator("setRateLimitHeaders")) {
    fastify.decorateReply(
      "setRateLimitHeaders",
      function (this: FastifyReply, result: RateLimitResult, nowMs?: number) {
        applyRateLimitHeaders(this, result, nowMs ?? now());
        return this;
      },
    );
  }

  if (!fastify.hasRequestDecorator("rateLimitResult")) {
    fastify.decorateRequest("rateLimitResult", undefined);
  }

  fastify.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const routeConfig = request.routeOptions?.config?.rateLimit;
    const limiter = routeConfig?.limiter ?? options.rateLimiter;

    if (!limiter || !routeConfig) {
      return;
    }

    const key: RateLimitKey = options.keyResolver
      ? await options.keyResolver(request)
      : {
          action: routeConfig.action ?? defaultAction,
          identifier: routeConfig.identifier ? routeConfig.identifier(request) : `ip:${request.ip}`,
          ...(routeConfig.namespace !== undefined ? { namespace: routeConfig.namespace } : {}),
        };

    const result = await limiter.check(key);
    request.rateLimitResult = result;
    applyRateLimitHeaders(reply, result, now());

    if (!result.allowed) {
      sendApiError(reply, "RATE_LIMITED", "Rate limit exceeded. Please retry later.");
      return reply;
    }
  });

  fastify.addHook(
    "onSend",
    async (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
      if (request.rateLimitResult && !reply.hasHeader(RATE_LIMIT_HEADERS.LIMIT)) {
        applyRateLimitHeaders(reply, request.rateLimitResult, now());
      }
      return payload;
    },
  );
}

export default registerRateLimitHeaders;
