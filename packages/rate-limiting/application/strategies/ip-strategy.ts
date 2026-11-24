import type { RateLimiter, RateLimitKey, RateLimitResult } from "@verixa/shared-kernel";

/**
 * Representation of an incoming HTTP request containing remote address and headers.
 */
export interface HttpRequestContext {
  remoteAddress: string;
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * Configuration options for IP extraction and rate-limiting strategy.
 */
export interface IpRateLimitStrategyOptions {
  /**
   * Number of trusted reverse proxies in front of the application.
   * If 0 (default), X-Forwarded-For headers are ignored and direct remoteAddress is used.
   * If > 0, the client IP is extracted by skipping the rightmost N trusted hops.
   */
  trustedProxyCount?: number;
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
 * Context passed to rate limit check operations.
 */
export interface IpRateLimitContext {
  request: HttpRequestContext;
  action?: RateLimitKey["action"];
  namespace?: string;
}

/**
 * Result returned by IpRateLimitStrategy, extending RateLimitResult with client IP details.
 */
export interface IpRateLimitResult extends RateLimitResult {
  clientIp: string;
  strategy: "ip";
}

/**
 * Extracts the real client IP address from request headers respecting trusted-proxy count.
 *
 * Algorithm:
 * - If trustedProxyCount <= 0: return request.remoteAddress (never trust XFF from direct connections).
 * - If trustedProxyCount > 0: inspect X-Forwarded-For.
 *   X-Forwarded-For contains hops: client, proxy1, proxy2, ...
 *   The rightmost N hops were appended by our N trusted proxies.
 *   The IP at index (ips.length - trustedProxyCount) is the untrusted client connecting to the outermost proxy.
 *   Any IPs preceding this index were supplied by the client and cannot be trusted (spoofed).
 */
export function extractClientIp(
  request: HttpRequestContext,
  options: { trustedProxyCount?: number } = {},
): string {
  const trustedProxyCount = options.trustedProxyCount ?? 0;
  if (trustedProxyCount <= 0) {
    return request.remoteAddress;
  }

  const rawHeader = request.headers?.["x-forwarded-for"] ?? request.headers?.["X-Forwarded-For"];
  if (!rawHeader) {
    return request.remoteAddress;
  }

  const headerValue = Array.isArray(rawHeader) ? rawHeader.join(",") : rawHeader;
  const ips = headerValue
    .split(",")
    .map((ip) => ip.trim())
    .filter((ip) => ip.length > 0);

  if (ips.length === 0) {
    return request.remoteAddress;
  }

  const targetIndex = ips.length - trustedProxyCount;
  if (targetIndex >= 0) {
    const candidate = ips.at(targetIndex);
    if (candidate) {
      return candidate;
    }
  }

  // Fewer hops than trusted proxy count: fallback to the first recorded hop
  return ips.at(0) ?? request.remoteAddress;
}

/**
 * Simple in-memory RateLimiter for standalone or fallback usage.
 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly defaultLimit: number = 60,
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
 * IpRateLimitStrategy
 *
 * Implements IP-based rate limiting by:
 * 1. Deriving client IP safely from request headers respecting trusted-proxy count.
 * 2. Generating bucket keys of shape: `ip:<clientIp>`.
 * 3. Checking and enforcing rate limits against a RateLimiter port.
 */
export class IpRateLimitStrategy {
  private readonly trustedProxyCount: number;
  private readonly defaultNamespace?: string;
  private readonly defaultAction: RateLimitKey["action"];

  constructor(
    private readonly rateLimiter: RateLimiter = new InMemoryRateLimiter(),
    options: IpRateLimitStrategyOptions = {},
  ) {
    this.trustedProxyCount = Math.max(0, options.trustedProxyCount ?? 0);
    if (options.namespace !== undefined) {
      this.defaultNamespace = options.namespace;
    }
    this.defaultAction = options.defaultAction ?? "login";
  }

  /**
   * Resolves the client IP for a request context.
   */
  resolveClientIp(request: HttpRequestContext): string {
    return extractClientIp(request, { trustedProxyCount: this.trustedProxyCount });
  }

  /**
   * Constructs the bucket key for an IP-based rate limit check.
   */
  getBucketKey(
    request: HttpRequestContext,
    action: RateLimitKey["action"] = this.defaultAction,
    namespace?: string,
  ): RateLimitKey {
    const clientIp = this.resolveClientIp(request);
    const ns = namespace ?? this.defaultNamespace;
    const key: RateLimitKey = {
      action,
      identifier: `ip:${clientIp}`,
      ...(ns !== undefined ? { namespace: ns } : {}),
    };
    return key;
  }

  /**
   * Consumes a token and checks if the request is allowed from this IP.
   */
  async check(context: IpRateLimitContext): Promise<IpRateLimitResult> {
    const clientIp = this.resolveClientIp(context.request);
    const key = this.getBucketKey(
      context.request,
      context.action ?? this.defaultAction,
      context.namespace,
    );

    const result = await this.rateLimiter.check(key);
    return {
      ...result,
      clientIp,
      strategy: "ip",
    };
  }

  /**
   * Records a failed attempt for this IP.
   */
  async recordFailure(context: IpRateLimitContext): Promise<void> {
    const key = this.getBucketKey(
      context.request,
      context.action ?? this.defaultAction,
      context.namespace,
    );
    await this.rateLimiter.recordFailure(key);
  }

  /**
   * Resets rate-limit bucket for this IP.
   */
  async reset(context: IpRateLimitContext): Promise<void> {
    const key = this.getBucketKey(
      context.request,
      context.action ?? this.defaultAction,
      context.namespace,
    );
    await this.rateLimiter.reset(key);
  }
}
