import type {
  CachedPolicy,
  PolicyCache,
  PolicyCacheKey,
  PolicyCacheSetOptions,
} from "../../application/ports/policy-cache.js";

/** Called once per degraded operation, so a cache outage is visible rather than silent. */
export type PolicyCacheDegradationHandler = (operation: string, error: unknown) => void;

export interface ResilientPolicyCacheOptions {
  /**
   * Observed whenever an operation is degraded. Wire this to the logger/metrics
   * of the surrounding context — an unavailable cache that nobody can see is an
   * unavailable cache nobody will fix, and the second thing it does after
   * logging is stop absorbing a stampede.
   */
  readonly onDegrade?: PolicyCacheDegradationHandler;
}

/**
 * Decorator that degrades cache failures to direct evaluation instead of failing requests.
 *
 * - A failed `get` becomes a miss, so the caller evaluates as on a cold cache. `undefined` only
 *   ever means "not cached".
 * - A failed `set` is swallowed.
 * - A failed invalidation is swallowed and reported. The stale window stays bounded by TTL and the
 *   version check, and publishing a policy, which may remove authority, is never blocked by a cache
 *   error.
 */
export class ResilientPolicyCache implements PolicyCache {
  private readonly onDegrade: PolicyCacheDegradationHandler | undefined;

  constructor(
    private readonly delegate: PolicyCache,
    options: ResilientPolicyCacheOptions = {},
  ) {
    this.onDegrade = options.onDegrade;
  }

  async get<TValue>(key: PolicyCacheKey): Promise<CachedPolicy<TValue> | undefined> {
    try {
      return await this.delegate.get<TValue>(key);
    } catch (error) {
      this.report("get", error);
      return undefined;
    }
  }

  async set<TValue>(
    key: PolicyCacheKey,
    entry: CachedPolicy<TValue>,
    options?: PolicyCacheSetOptions,
  ): Promise<void> {
    try {
      await this.delegate.set(key, entry, options);
    } catch (error) {
      this.report("set", error);
    }
  }

  async invalidate(key: PolicyCacheKey): Promise<void> {
    try {
      await this.delegate.invalidate(key);
    } catch (error) {
      this.report("invalidate", error);
    }
  }

  async invalidateResourceType(resourceType: string): Promise<void> {
    try {
      await this.delegate.invalidateResourceType(resourceType);
    } catch (error) {
      this.report("invalidateResourceType", error);
    }
  }

  async invalidateAll(): Promise<void> {
    try {
      await this.delegate.invalidateAll();
    } catch (error) {
      this.report("invalidateAll", error);
    }
  }

  private report(operation: string, error: unknown): void {
    this.onDegrade?.(operation, error);
  }
}
