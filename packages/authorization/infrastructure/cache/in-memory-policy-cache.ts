import type {
  CachedPolicy,
  PolicyCache,
  PolicyCacheKey,
  PolicyCacheSetOptions,
} from "../../application/ports/policy-cache.js";

/** Default TTL for entries that do not name one: five minutes. */
export const DEFAULT_POLICY_CACHE_TTL_SECONDS = 300;

export interface InMemoryPolicyCacheOptions {
  /**
   * TTL applied when a caller does not pass one. Bounds memory only — the
   * version check is what keeps stale entries from being used.
   */
  readonly defaultTtlSeconds?: number;
  /**
   * Clock used for expiry, injectable so TTL behaviour is testable without
   * sleeping. Defaults to `Date.now`.
   */
  readonly now?: () => number;
}

interface StoredEntry {
  readonly value: unknown;
  readonly policyVersion: string;
  readonly cachedAt: string;
  readonly expiresAt: number;
}

/**
 * Single-process {@link PolicyCache} for single-node deployments, tests and the CLI, and the
 * reference implementation for the contract suite. Like the Redis adapter, invalidation bumps a
 * generation counter instead of deleting entries, so old entries become unreachable immediately and
 * expire by TTL.
 */
export class InMemoryPolicyCache implements PolicyCache {
  private readonly entries = new Map<string, StoredEntry>();
  private readonly generations = new Map<string, number>();
  private globalGeneration = 0;
  private readonly defaultTtlSeconds: number;
  private readonly now: () => number;

  constructor(options: InMemoryPolicyCacheOptions = {}) {
    this.defaultTtlSeconds = options.defaultTtlSeconds ?? DEFAULT_POLICY_CACHE_TTL_SECONDS;
    this.now = options.now ?? Date.now;
  }

  get<TValue>(key: PolicyCacheKey): Promise<CachedPolicy<TValue> | undefined> {
    const stored = this.entries.get(this.entryKey(key));
    if (stored === undefined) {
      return Promise.resolve(undefined);
    }

    if (stored.expiresAt <= this.now()) {
      // Lazy expiry: a read is the only moment we must be correct about it.
      this.entries.delete(this.entryKey(key));
      return Promise.resolve(undefined);
    }

    return Promise.resolve({
      value: stored.value as TValue,
      policyVersion: stored.policyVersion,
      cachedAt: stored.cachedAt,
    });
  }

  set<TValue>(
    key: PolicyCacheKey,
    entry: CachedPolicy<TValue>,
    options: PolicyCacheSetOptions = {},
  ): Promise<void> {
    const ttlSeconds = options.ttlSeconds ?? this.defaultTtlSeconds;
    if (ttlSeconds <= 0) {
      // A non-positive TTL can never be read back, so writing it is dead work —
      // and, worse, it would look like a successful write to the caller.
      return Promise.resolve();
    }

    this.entries.set(this.entryKey(key), {
      value: entry.value,
      policyVersion: entry.policyVersion,
      cachedAt: entry.cachedAt,
      expiresAt: this.now() + ttlSeconds * 1000,
    });
    return Promise.resolve();
  }

  invalidate(key: PolicyCacheKey): Promise<void> {
    this.entries.delete(this.entryKey(key));
    return Promise.resolve();
  }

  invalidateResourceType(resourceType: string): Promise<void> {
    this.generations.set(resourceType, this.generationFor(resourceType) + 1);
    return Promise.resolve();
  }

  invalidateAll(): Promise<void> {
    this.globalGeneration += 1;
    return Promise.resolve();
  }

  /**
   * The generation an entry written now would live under, exposed so a caller
   * (and the tests) can observe invalidation without reaching into internals.
   */
  generationOf(resourceType: string): string {
    return `${this.globalGeneration}:${this.generationFor(resourceType)}`;
  }

  private generationFor(resourceType: string): number {
    return this.generations.get(resourceType) ?? 0;
  }

  private entryKey(key: PolicyCacheKey): string {
    return `${this.generationOf(key.resourceType)}|${key.resourceType}|${key.action}`;
  }
}
