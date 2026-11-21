import { CaptchaTriggerPolicy } from "@verixa/rate-limiting";
import type { RateLimitKey, RateLimiter, RateLimitResult } from "@verixa/shared-kernel";

export interface RateLimitPolicyConfig {
  readonly limit: number;
  readonly windowMs: number;
}

export interface CredentialRateLimiterOptions {
  readonly policies?: Partial<Record<RateLimitKey["action"], RateLimitPolicyConfig>> | undefined;
  readonly defaultPolicy?: RateLimitPolicyConfig | undefined;
  readonly captchaFailureThreshold?: number | undefined;
  readonly captchaWindowMs?: number | undefined;
}

/** Default production-grade limits for credential-adjacent endpoints */
export const DEFAULT_CREDENTIAL_RATE_LIMIT_POLICIES: Record<
  RateLimitKey["action"],
  RateLimitPolicyConfig
> = {
  login: { limit: 100, windowMs: 60_000 },
  register: { limit: 50, windowMs: 60_000 },
  "password-reset": { limit: 50, windowMs: 60_000 },
  "email-verification": { limit: 50, windowMs: 60_000 },
  mfa: { limit: 50, windowMs: 60_000 },
  "api-key": { limit: 60, windowMs: 60_000 },
};

/**
 * Production-grade RateLimiter implementation wiring rate-limiting policies and CAPTCHA trigger tracking.
 */
export class ProductionCredentialRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();
  readonly captchaPolicy: CaptchaTriggerPolicy;

  constructor(private readonly options: CredentialRateLimiterOptions = {}) {
    this.captchaPolicy = new CaptchaTriggerPolicy({
      ...(options.captchaFailureThreshold !== undefined
        ? { failureThreshold: options.captchaFailureThreshold }
        : {}),
      ...(options.captchaWindowMs !== undefined ? { windowMs: options.captchaWindowMs } : {}),
    });
  }

  async check(key: RateLimitKey): Promise<RateLimitResult> {
    await Promise.resolve();
    const policy = this.options.policies?.[key.action] ??
      DEFAULT_CREDENTIAL_RATE_LIMIT_POLICIES[key.action] ??
      this.options.defaultPolicy ?? { limit: 60, windowMs: 60_000 };

    const bucketKey = `${key.namespace ?? "default"}:${key.action}:${key.identifier.toLowerCase()}`;
    const now = Date.now();
    const entry = this.buckets.get(bucketKey);

    if (!entry || now >= entry.resetAt) {
      const resetAt = now + policy.windowMs;
      this.buckets.set(bucketKey, { count: 1, resetAt });
      return {
        allowed: 1 <= policy.limit,
        remaining: Math.max(0, policy.limit - 1),
        resetAt,
        limit: policy.limit,
      };
    }

    entry.count += 1;
    return {
      allowed: entry.count <= policy.limit,
      remaining: Math.max(0, policy.limit - entry.count),
      resetAt: entry.resetAt,
      limit: policy.limit,
    };
  }

  async recordFailure(key: RateLimitKey): Promise<void> {
    await Promise.resolve();
    this.captchaPolicy.recordFailure({
      identifier: key.identifier,
      action: key.action,
    });
  }

  async reset(key: RateLimitKey): Promise<void> {
    await Promise.resolve();
    const bucketKey = `${key.namespace ?? "default"}:${key.action}:${key.identifier.toLowerCase()}`;
    this.buckets.delete(bucketKey);
    this.captchaPolicy.recordSuccess({
      identifier: key.identifier,
      action: key.action,
    });
  }
}

export function createCredentialRateLimiter(
  options: CredentialRateLimiterOptions = {},
): ProductionCredentialRateLimiter {
  return new ProductionCredentialRateLimiter(options);
}
