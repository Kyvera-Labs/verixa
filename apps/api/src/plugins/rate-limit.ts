import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";
import type { Redis } from "ioredis";

import { sendApiError } from "../http/error-response.js";

declare module "fastify" {
  interface FastifyContextConfig {
    rateLimit?: {
      max?: number;
      timeWindowMs?: number;
      identifier?: (req: FastifyRequest) => string;
    };
  }
}

export interface RateLimitPluginOptions {
  redisClient?: Redis;
  defaultMax?: number;
  defaultTimeWindowMs?: number;
}

/**
 * Rate limit plugin for principal-aware and per-route rate limiting.
 * Uses sliding window counter or fixed window in Redis, and falls back to in-memory store if Redis is absent.
 */
export class RateLimiterStore {
  private memoryStore = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly redis?: Redis) {}

  async consume(
    key: string,
    limit: number,
    windowMs: number,
  ): Promise<{ allowed: boolean; remaining: number; resetAt: number; retryAfterSeconds: number }> {
    const now = Date.now();

    if (this.redis) {
      const redisKey = `ratelimit:${key}`;
      const multi = this.redis.multi();
      multi.incr(redisKey);
      multi.pttl(redisKey);
      const results = await multi.exec();

      if (results && results[0] && !results[0][0]) {
        const count = results[0][1] as number;
        let pttl = results[1] ? (results[1][1] as number) : -1;

        if (count === 1 || pttl < 0) {
          await this.redis.pexpire(redisKey, windowMs);
          pttl = windowMs;
        }

        const resetAt = now + Math.max(0, pttl);
        const retryAfterSeconds = Math.max(1, Math.ceil(pttl / 1000));
        const remaining = Math.max(0, limit - count);

        return {
          allowed: count <= limit,
          remaining,
          resetAt,
          retryAfterSeconds,
        };
      }
    }

    // In-memory fallback
    const entry = this.memoryStore.get(key);
    if (!entry || now >= entry.resetAt) {
      const resetAt = now + windowMs;
      this.memoryStore.set(key, { count: 1, resetAt });
      return {
        allowed: 1 <= limit,
        remaining: Math.max(0, limit - 1),
        resetAt,
        retryAfterSeconds: Math.ceil(windowMs / 1000),
      };
    }

    entry.count += 1;
    const pttl = Math.max(0, entry.resetAt - now);
    const retryAfterSeconds = Math.max(1, Math.ceil(pttl / 1000));
    const remaining = Math.max(0, limit - entry.count);

    return {
      allowed: entry.count <= limit,
      remaining,
      resetAt: entry.resetAt,
      retryAfterSeconds,
    };
  }
}

export function registerRateLimit<TLogger extends FastifyBaseLogger = FastifyBaseLogger>(
  fastify: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression,
    RawReplyDefaultExpression,
    TLogger
  >,
  opts: RateLimitPluginOptions = {},
): void {
  const defaultMax = opts.defaultMax ?? 100;
  const defaultTimeWindowMs = opts.defaultTimeWindowMs ?? 60_000;
  const store = new RateLimiterStore(opts.redisClient);

  fastify.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    // Determine principal key: user id from session/header or API key, falling back to IP
    const userHeader = request.headers["x-user-id"];
    const principalId =
      typeof userHeader === "string" && userHeader.length > 0
        ? `user:${userHeader}`
        : request.headers["x-api-key"] && typeof request.headers["x-api-key"] === "string"
          ? `apikey:${request.headers["x-api-key"]}`
          : `ip:${request.ip}`;

    const routeConfig = request.routeOptions?.config?.rateLimit;
    const max = routeConfig?.max ?? defaultMax;
    const windowMs = routeConfig?.timeWindowMs ?? defaultTimeWindowMs;
    const key = routeConfig?.identifier
      ? routeConfig.identifier(request)
      : `${request.url}:${principalId}`;

    const result = await store.consume(key, max, windowMs);

    reply.header("X-RateLimit-Limit", max.toString());
    reply.header("X-RateLimit-Remaining", result.remaining.toString());
    reply.header("X-RateLimit-Reset", Math.ceil(result.resetAt / 1000).toString());

    if (!result.allowed) {
      reply.header("Retry-After", result.retryAfterSeconds.toString());
      sendApiError(reply, "RATE_LIMITED", "Rate limit exceeded. Please retry later.");
      return reply;
    }
  });
}

export default registerRateLimit;
