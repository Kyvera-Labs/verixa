import type { Redis } from "ioredis";

import type {
  CachedPolicy,
  PolicyCache,
  PolicyCacheKey,
  PolicyCacheSetOptions,
} from "../../application/ports/policy-cache.js";

/** Default TTL for entries that do not name one: five minutes. */
export const DEFAULT_POLICY_CACHE_TTL_SECONDS = 300;

export interface RedisPolicyCacheOptions {
  /**
   * Namespace prepended to every key. Keeps the policy cache from colliding with
   * anything else sharing the same Redis, and makes `SCAN policy:cache:*` a
   * meaningful operational query.
   */
  readonly keyPrefix?: string;
  /** TTL applied when a caller does not pass one. */
  readonly defaultTtlSeconds?: number;
}

const DEFAULT_KEY_PREFIX = "policy:cache:";

/**
 * Redis-backed {@link PolicyCache}.
 *
 * Invalidation uses generation counters (one global, one per resource type) embedded in each entry
 * key. Invalidating a resource type is a single atomic `INCR` that makes its old entries
 * unreachable at once without `SCAN` or `KEYS`. Superseded keys expire by TTL; correctness comes
 * from the policy version each entry carries.
 *
 * Redis errors propagate. Degrading through an outage, and reporting it, is
 * `ResilientPolicyCache`'s job.
 *
 * The connected client is injected and `ioredis` is imported only as a type, so the composition
 * root owns connection, TLS and pooling. Values must survive a JSON round trip.
 */
export class RedisPolicyCache implements PolicyCache {
  private readonly keyPrefix: string;
  private readonly defaultTtlSeconds: number;

  constructor(
    private readonly redis: Redis,
    options: RedisPolicyCacheOptions = {},
  ) {
    this.keyPrefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
    this.defaultTtlSeconds = options.defaultTtlSeconds ?? DEFAULT_POLICY_CACHE_TTL_SECONDS;
  }

  async get<TValue>(key: PolicyCacheKey): Promise<CachedPolicy<TValue> | undefined> {
    const generations = await this.currentGenerations(key.resourceType);
    const stored = await this.redis.get(this.entryKey(key, generations));

    // A missing key is a miss; so is a value written under a generation that has
    // since been superseded (that key is simply no longer the one we look at).
    if (stored === null) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(stored) as CachedPolicy<TValue>;
      return parsed;
    } catch {
      // A value this adapter cannot read is a miss, not a request failure: the
      // caller recomputes from the source of truth, which is always correct.
      // Deleting it keeps a corrupt entry from being re-read until its TTL.
      await this.redis.del(this.entryKey(key, generations));
      return undefined;
    }
  }

  async set<TValue>(
    key: PolicyCacheKey,
    entry: CachedPolicy<TValue>,
    options: PolicyCacheSetOptions = {},
  ): Promise<void> {
    const ttlSeconds = options.ttlSeconds ?? this.defaultTtlSeconds;
    if (ttlSeconds <= 0) {
      // A non-positive TTL can never be read back; Redis would also reject a
      // zero or negative EX. Write nothing rather than pretend to cache.
      return;
    }

    const generations = await this.currentGenerations(key.resourceType);
    // EX, not a manual expiry: Redis then evicts the superseded entries for us.
    await this.redis.set(
      this.entryKey(key, generations),
      JSON.stringify(entry),
      "EX",
      // Round up: flooring a fractional second would let an entry expire a hair
      // before the caller's intended window closed.
      Math.ceil(ttlSeconds),
    );
  }

  async invalidate(key: PolicyCacheKey): Promise<void> {
    const generations = await this.currentGenerations(key.resourceType);
    await this.redis.del(this.entryKey(key, generations));
  }

  async invalidateResourceType(resourceType: string): Promise<void> {
    await this.redis.incr(this.generationKey(resourceType));
  }

  async invalidateAll(): Promise<void> {
    await this.redis.incr(this.globalGenerationKey());
  }

  private async currentGenerations(resourceType: string): Promise<string> {
    const [global, resource] = await this.redis.mget(
      this.globalGenerationKey(),
      this.generationKey(resourceType),
    );
    return `${global ?? "0"}:${resource ?? "0"}`;
  }

  private entryKey(key: PolicyCacheKey, generations: string): string {
    return `${this.keyPrefix}entry:${generations}:${key.resourceType}:${key.action}`;
  }

  private generationKey(resourceType: string): string {
    return `${this.keyPrefix}gen:${resourceType}`;
  }

  private globalGenerationKey(): string {
    return `${this.keyPrefix}gen:`;
  }
}
