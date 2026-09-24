import type { RateLimiter, RateLimitResult } from "../application/ports/rate-limiter.js";

/**
 * No-op RateLimiter adapter — always allows requests.
 * Used in tests and until Phase 15 implements the real limiter.
 * Wired as default adapter so use cases work before real limiter exists.
 */
export class NoopRateLimiter implements RateLimiter {
  // eslint-disable-next-line @typescript-eslint/require-await
  async check(): Promise<RateLimitResult> {
    return {
      allowed: true,
      remaining: 999,
      resetAt: Date.now() + 60_000,
      limit: 1000,
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async recordFailure(): Promise<void> {
    // no-op
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async reset(): Promise<void> {
    // no-op
  }
}
