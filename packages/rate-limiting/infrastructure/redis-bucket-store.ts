import type { Redis } from "ioredis";

export const CONSUME_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate_per_sec = tonumber(ARGV[2])
local requested = tonumber(ARGV[3])
local now_ms = tonumber(ARGV[4])
local ttl_seconds = tonumber(ARGV[5])

local data = redis.call("HMGET", key, "tokens", "last_refill")
local current_tokens
local last_refill_ms

if data[1] == false or data[1] == nil then
  current_tokens = capacity
  last_refill_ms = now_ms
else
  current_tokens = tonumber(data[1])
  last_refill_ms = tonumber(data[2])

  if now_ms > last_refill_ms then
    local elapsed_ms = now_ms - last_refill_ms
    local refilled = (elapsed_ms / 1000.0) * refill_rate_per_sec
    current_tokens = math.min(capacity, current_tokens + refilled)
    last_refill_ms = now_ms
  end
end

local allowed = 0
local time_to_next_ms = 0

if current_tokens >= requested then
  allowed = 1
  current_tokens = current_tokens - requested
  if current_tokens < capacity then
    local frac = current_tokens % 1
    local needed_for_next = 1.0 - frac
    if needed_for_next <= 0 then
      needed_for_next = 1.0
    end
    time_to_next_ms = math.ceil((needed_for_next / refill_rate_per_sec) * 1000.0)
  else
    time_to_next_ms = 0
  end
else
  allowed = 0
  local deficit = requested - current_tokens
  time_to_next_ms = math.ceil((deficit / refill_rate_per_sec) * 1000.0)
end

redis.call("HMSET", key, "tokens", tostring(current_tokens), "last_refill", tostring(last_refill_ms))
redis.call("EXPIRE", key, ttl_seconds)

return { allowed, tostring(current_tokens), time_to_next_ms }
`;

export interface RedisBucketStoreOptions {
  /**
   * Namespace prefix prepended to all bucket keys.
   * Key pattern: `${keyPrefix}{scope}:{key}`.
   * Default: "ratelimit:"
   */
  readonly keyPrefix?: string | undefined;

  /**
   * Default idle TTL in seconds when not specified in consume call.
   * Default: 3600 (1 hour).
   */
  readonly defaultTtlSeconds?: number | undefined;
}

export interface ConsumeParams {
  /** High-level namespace or route scope, e.g. "login", "global", "api". */
  readonly scope: string;

  /** Target identifier, e.g. client IP or account ID. */
  readonly key: string;

  /** Maximum bucket capacity. */
  readonly capacity: number;

  /** Tokens replenished per second. */
  readonly refillRatePerSecond: number;

  /** Number of tokens to consume. Defaults to 1. */
  readonly requested?: number | undefined;

  /** Current timestamp in milliseconds. Defaults to `Date.now()`. */
  readonly nowMs?: number | undefined;

  /** Key TTL in seconds. Defaults to `defaultTtlSeconds` or calculated from refill time. */
  readonly ttlSeconds?: number | undefined;
}

export interface BucketConsumeResult {
  /** Whether the consumption succeeded. */
  readonly allowed: boolean;

  /** Number of tokens remaining after this operation. */
  readonly remainingTokens: number;

  /** Milliseconds until at least one more token is replenished. */
  readonly timeToNextTokenMs: number;
}

/**
 * Distributed rate-limiting bucket store backed by Redis.
 *
 * Uses an atomic Lua script (`consume-bucket.lua`) to perform read-refill-consume
 * in a single atomic transaction within Redis, eliminating read-modify-write
 * race conditions across horizontally scaled API workers.
 */
export class RedisBucketStore {
  private readonly client: Redis;
  private readonly keyPrefix: string;
  private readonly defaultTtlSeconds: number;

  constructor(client: Redis, options: RedisBucketStoreOptions = {}) {
    this.client = client;
    this.keyPrefix = options.keyPrefix ?? "ratelimit:";
    this.defaultTtlSeconds = options.defaultTtlSeconds ?? 3600;
  }

  /**
   * Builds the fully-qualified Redis key conforming to `ratelimit:{scope}:{key}`.
   */
  buildKey(scope: string, key: string): string {
    return `${this.keyPrefix}${scope}:${key}`;
  }

  /**
   * Atomically reads current state, refills proportional to elapsed time,
   * decrements requested tokens if available, and sets the idle expiration TTL.
   */
  async consume(params: ConsumeParams): Promise<BucketConsumeResult> {
    if (params.capacity <= 0) {
      throw new RangeError(`Capacity must be > 0, got ${params.capacity}`);
    }
    if (params.refillRatePerSecond <= 0) {
      throw new RangeError(`Refill rate must be > 0, got ${params.refillRatePerSecond}`);
    }

    const requested = params.requested ?? 1;
    if (requested <= 0) {
      throw new RangeError(`Requested tokens must be > 0, got ${requested}`);
    }

    const nowMs = params.nowMs ?? Date.now();
    const redisKey = this.buildKey(params.scope, params.key);

    // Calculate a safe TTL: idle keys expire after enough time to fully refill + buffer
    const calculatedTtl = Math.ceil((params.capacity / params.refillRatePerSecond) * 2) + 60;
    const ttlSeconds = params.ttlSeconds ?? Math.max(this.defaultTtlSeconds, calculatedTtl);

    const result = (await this.client.eval(
      CONSUME_BUCKET_LUA,
      1,
      redisKey,
      params.capacity.toString(),
      params.refillRatePerSecond.toString(),
      requested.toString(),
      nowMs.toString(),
      ttlSeconds.toString(),
    )) as [number, string, number];

    const [allowedNum, remainingStr, timeToNextMs] = result;

    return {
      allowed: allowedNum === 1,
      remainingTokens: Number.parseFloat(remainingStr),
      timeToNextTokenMs: Number(timeToNextMs),
    };
  }

  /**
   * Returns current available tokens for an identifier without consuming any tokens.
   */
  async getTokens(
    scope: string,
    key: string,
    capacity: number,
    refillRatePerSecond: number,
    nowMs: number = Date.now(),
  ): Promise<number> {
    const redisKey = this.buildKey(scope, key);
    const data = await this.client.hmget(redisKey, "tokens", "last_refill");

    const tokensStr = data[0];
    const lastRefillStr = data[1];

    if (!tokensStr || !lastRefillStr) {
      return capacity;
    }

    const currentTokens = Number.parseFloat(tokensStr);
    const lastRefillMs = Number.parseInt(lastRefillStr, 10);

    if (nowMs > lastRefillMs) {
      const elapsedMs = nowMs - lastRefillMs;
      const refilled = (elapsedMs / 1000) * refillRatePerSecond;
      return Math.min(capacity, currentTokens + refilled);
    }

    return currentTokens;
  }

  /**
   * Resets the rate limit state for a key.
   */
  async reset(scope: string, key: string): Promise<void> {
    const redisKey = this.buildKey(scope, key);
    await this.client.del(redisKey);
  }
}
