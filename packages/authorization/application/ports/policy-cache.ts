/**
 * Cache port for values derived from the policy set (compiled ASTs and optionally decisions),
 * generic over the cached value.
 *
 * A stale entry here can turn a deny into a permit, so the contract is strict:
 *
 * - Invalidation is required, not left to TTL. Entries live under a generation that invalidation
 *   advances in one atomic write, with no key scans.
 * - Every entry carries its policy version; a reader treats a version mismatch as a miss. TTL only
 *   bounds memory.
 * - `get` returns `undefined` for both a miss and a failure, so a cache outage degrades to direct
 *   evaluation, never to a decision.
 * - `set` and the `invalidate*` methods may throw so a failed invalidation is never silent. Wrap
 *   the adapter in {@link ResilientPolicyCache} to keep serving with a reported degradation.
 */

/** What a cached entry is keyed by: the policy target selector, not the request. */
export interface PolicyCacheKey {
  /** Resource type the policy targets, e.g. `document`. */
  readonly resourceType: string;
  /** Action the policy targets, e.g. `document:read`. */
  readonly action: string;
}

/** A cached value plus the provenance needed to refuse it. */
export interface CachedPolicy<TValue> {
  readonly value: TValue;
  /**
   * Version of the policy set `value` was derived from. A reader compares this
   * against the active version and treats a mismatch as a miss (threat E-3).
   */
  readonly policyVersion: string;
  /** When the entry was written (ISO-8601), for operational visibility. */
  readonly cachedAt: string;
}

/** Options accepted by {@link PolicyCache.set}. */
export interface PolicyCacheSetOptions {
  /**
   * Time-to-live in seconds. Bounds memory, not correctness: an entry that
   * outlives its policy version is refused by the version check, not by expiry.
   */
  readonly ttlSeconds?: number;
}

/** Port implemented by the in-memory adapter and the Redis adapter. */
export interface PolicyCache {
  /**
   * Reads the entry for `key`.
   *
   * @returns the entry, or `undefined` for a miss — including when the entry
   * existed but has expired. A miss is not an error and must not throw.
   */
  get<TValue>(key: PolicyCacheKey): Promise<CachedPolicy<TValue> | undefined>;

  /**
   * Writes `entry` for `key`.
   *
   * A write must be visible to a `get` for the same key on this node before this
   * promise resolves; cross-node visibility is bounded by the store's replication,
   * which is why readers rely on the version check rather than on write
   * visibility.
   */
  set<TValue>(
    key: PolicyCacheKey,
    entry: CachedPolicy<TValue>,
    options?: PolicyCacheSetOptions,
  ): Promise<void>;

  /**
   * Invalidates one key — the narrow form, for a single policy whose target
   * selector changed while its version stayed put.
   */
  invalidate(key: PolicyCacheKey): Promise<void>;

  /**
   * Invalidates every entry for one resource type. This is the operation a
   * publish of a policy targeting that resource type must call before it
   * reports success.
   */
  invalidateResourceType(resourceType: string): Promise<void>;

  /** Invalidates everything, for operations that cannot name what they changed. */
  invalidateAll(): Promise<void>;
}
