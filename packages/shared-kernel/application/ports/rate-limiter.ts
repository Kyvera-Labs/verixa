/**
 * The request-rate gate Issue 074 declared and Phase 15 implements (Issue 209).
 *
 * Interface only, deliberately: a limiter that counts requests per window is a
 * different mechanism from a policy that counts *failed* attempts per secret,
 * and the two have to compose. Declaring the port here is what lets
 * `BruteForcePolicy` reason about both today, against whatever the composition
 * root supplies — including nothing at all.
 */

export interface RateLimitDecision {
  readonly allowed: boolean;
  /**
   * Seconds the caller should wait, when the limiter knows. `undefined` means
   * it does not, and is different from `0`.
   */
  readonly retryAfterSeconds?: number;
}

export interface RateLimiter {
  /**
   * Whether `key` may make a request now.
   *
   * Checking never consumes budget — recording is a separate concern, and a
   * caller that checks then fails for another reason must not pay for a
   * request it did not get to make.
   */
  check(key: string): Promise<RateLimitDecision>;
}
