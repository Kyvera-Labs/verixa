import type { RateLimiter, RateLimitKey, RateLimitResult } from "@verixa/shared-kernel";

/**
 * Configuration options for AccountRateLimitStrategy.
 */
export interface AccountRateLimitStrategyOptions {
  /**
   * Default namespace to use for rate-limit keys.
   */
  namespace?: string;
  /**
   * Default route action when none is specified.
   */
  defaultAction?: RateLimitKey["action"];
}

/**
 * Context passed to account rate limit check operations.
 */
export interface AccountRateLimitContext {
  /**
   * The target account identifier (e.g. email address or userId).
   */
  accountIdentifier: string;
  /**
   * Optional action being performed (defaults to "login").
   */
  action?: RateLimitKey["action"];
  /**
   * Optional multi-tenant namespace.
   */
  namespace?: string;
  /**
   * Optional client IP address (informational/logging purposes).
   */
  clientIp?: string;
}

/**
 * Result returned by AccountRateLimitStrategy.
 */
export interface AccountRateLimitResult extends RateLimitResult {
  accountIdentifier: string;
  strategy: "account";
}

/**
 * Normalizes an account identifier to prevent casing or whitespace bypasses.
 */
export function normalizeAccountIdentifier(rawIdentifier: string): string {
  const trimmed = rawIdentifier.trim();
  // If identifier looks like an email address, normalize to lowercase
  if (trimmed.includes("@")) {
    return trimmed.toLowerCase();
  }
  return trimmed;
}

/**
 * In-memory fallback RateLimiter for standalone usage.
 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly defaultLimit: number = 10,
    private readonly windowMs: number = 60_000,
  ) {}

  async check(key: RateLimitKey): Promise<RateLimitResult> {
    await Promise.resolve();
    const k = `${key.namespace ?? "default"}:${key.action}:${key.identifier}`;
    const now = Date.now();
    const entry = this.buckets.get(k);

    if (!entry || now >= entry.resetAt) {
      const resetAt = now + this.windowMs;
      this.buckets.set(k, { count: 1, resetAt });
      return {
        allowed: 1 <= this.defaultLimit,
        remaining: Math.max(0, this.defaultLimit - 1),
        resetAt,
        limit: this.defaultLimit,
      };
    }

    entry.count += 1;
    return {
      allowed: entry.count <= this.defaultLimit,
      remaining: Math.max(0, this.defaultLimit - entry.count),
      resetAt: entry.resetAt,
      limit: this.defaultLimit,
    };
  }

  async recordFailure(key: RateLimitKey): Promise<void> {
    await Promise.resolve();
    void key;
  }

  async reset(key: RateLimitKey): Promise<void> {
    await Promise.resolve();
    const k = `${key.namespace ?? "default"}:${key.action}:${key.identifier}`;
    this.buckets.delete(k);
  }
}

/**
 * AccountRateLimitStrategy
 *
 * Implements account-scoped rate limiting by:
 * 1. Normalizing the account identifier (email/userId).
 * 2. Deriving bucket keys of shape: `account:<normalizedIdentifier>`.
 * 3. Enforcing limits against a RateLimiter port across distributed IPs targeting the same account.
 */
export class AccountRateLimitStrategy {
  private readonly defaultNamespace?: string;
  private readonly defaultAction: RateLimitKey["action"];

  constructor(
    private readonly rateLimiter: RateLimiter = new InMemoryRateLimiter(),
    options: AccountRateLimitStrategyOptions = {},
  ) {
    if (options.namespace !== undefined) {
      this.defaultNamespace = options.namespace;
    }
    this.defaultAction = options.defaultAction ?? "login";
  }

  /**
   * Constructs the bucket key for an account-based rate limit check.
   */
  getBucketKey(
    accountIdentifier: string,
    action: RateLimitKey["action"] = this.defaultAction,
    namespace?: string,
  ): RateLimitKey {
    const normalized = normalizeAccountIdentifier(accountIdentifier);
    const ns = namespace ?? this.defaultNamespace;
    const key: RateLimitKey = {
      action,
      identifier: `account:${normalized}`,
      ...(ns !== undefined ? { namespace: ns } : {}),
    };
    return key;
  }

  /**
   * Consumes a token and checks if the request targeting this account is allowed.
   */
  async check(context: AccountRateLimitContext): Promise<AccountRateLimitResult> {
    const normalized = normalizeAccountIdentifier(context.accountIdentifier);
    const key = this.getBucketKey(
      normalized,
      context.action ?? this.defaultAction,
      context.namespace,
    );

    const result = await this.rateLimiter.check(key);
    return {
      ...result,
      accountIdentifier: normalized,
      strategy: "account",
    };
  }

  /**
   * Records a failed attempt for this account.
   */
  async recordFailure(context: AccountRateLimitContext): Promise<void> {
    const key = this.getBucketKey(
      context.accountIdentifier,
      context.action ?? this.defaultAction,
      context.namespace,
    );
    await this.rateLimiter.recordFailure(key);
  }

  /**
   * Resets the rate-limit bucket for this account.
   */
  async reset(context: AccountRateLimitContext): Promise<void> {
    const key = this.getBucketKey(
      context.accountIdentifier,
      context.action ?? this.defaultAction,
      context.namespace,
    );
    await this.rateLimiter.reset(key);
  }
}
