/**
 * Token bucket: allows bursts up to `capacity` and refills continuously at `refillRatePerSecond`,
 * proportionally to elapsed milliseconds. Pure domain logic with an injectable clock for
 * deterministic tests.
 */

export interface Clock {
  now(): Date;
}

export interface TokenBucketOptions {
  /** Maximum number of tokens the bucket can hold. Must be > 0. */
  readonly capacity: number;

  /** Number of tokens added to the bucket per second. Must be > 0. */
  readonly refillRatePerSecond: number;

  /**
   * Initial tokens in the bucket at creation time.
   * Defaults to `capacity`. Clamped between 0 and `capacity`.
   */
  readonly initialTokens?: number | undefined;

  /**
   * Clock source for determining elapsed time.
   * Defaults to system time (`new Date()`).
   */
  readonly clock?: Clock | undefined;
}

export interface ConsumeResult {
  /** Whether the requested tokens were successfully consumed. */
  readonly consumed: boolean;

  /** Number of tokens remaining in the bucket after this attempt. */
  readonly remainingTokens: number;

  /**
   * Estimated milliseconds until at least one more token is available.
   * When `consumed` is false, this is the time until the requested amount can be consumed.
   * Returns 0 if bucket is already at capacity or has tokens available.
   */
  readonly timeToNextTokenMs: number;
}

export class TokenBucket {
  private readonly capacity: number;
  private readonly refillRatePerSecond: number;
  private readonly clock: Clock;
  private currentTokens: number;
  private lastRefillTimestampMs: number;

  constructor(options: TokenBucketOptions) {
    if (!Number.isFinite(options.capacity) || options.capacity <= 0) {
      throw new RangeError(
        `TokenBucket capacity must be a positive finite number, got ${options.capacity}`,
      );
    }
    if (!Number.isFinite(options.refillRatePerSecond) || options.refillRatePerSecond <= 0) {
      throw new RangeError(
        `TokenBucket refillRatePerSecond must be a positive finite number, got ${options.refillRatePerSecond}`,
      );
    }

    this.capacity = options.capacity;
    this.refillRatePerSecond = options.refillRatePerSecond;
    this.clock = options.clock ?? { now: () => new Date() };

    const initial = options.initialTokens ?? options.capacity;
    if (!Number.isFinite(initial)) {
      throw new RangeError(`TokenBucket initialTokens must be a finite number, got ${initial}`);
    }
    this.currentTokens = Math.max(0, Math.min(this.capacity, initial));
    this.lastRefillTimestampMs = this.clock.now().getTime();
  }

  /**
   * Returns the maximum token capacity of this bucket.
   */
  getCapacity(): number {
    return this.capacity;
  }

  /**
   * Returns the refill rate in tokens per second.
   */
  getRefillRatePerSecond(): number {
    return this.refillRatePerSecond;
  }

  /**
   * Returns the timestamp of the last token refill.
   */
  getLastRefillAt(): Date {
    return new Date(this.lastRefillTimestampMs);
  }

  /**
   * Computes elapsed time, adds tokens proportionally, and returns current available tokens.
   */
  getAvailableTokens(): number {
    this.refill();
    return this.currentTokens;
  }

  /**
   * Refills the bucket based on the elapsed time since `lastRefillTimestampMs`.
   * Capped at `capacity`.
   */
  refill(): number {
    const nowMs = this.clock.now().getTime();
    if (nowMs > this.lastRefillTimestampMs) {
      const elapsedMs = nowMs - this.lastRefillTimestampMs;
      const refilled = (elapsedMs / 1000) * this.refillRatePerSecond;
      this.currentTokens = Math.min(this.capacity, this.currentTokens + refilled);
      this.lastRefillTimestampMs = nowMs;
    }
    return this.currentTokens;
  }

  /**
   * Attempts to consume `tokens` from the bucket.
   *
   * @param tokens Number of tokens to consume (default: 1).
   * @returns `ConsumeResult` with consumption outcome, remaining tokens, and timeToNextTokenMs.
   */
  tryConsume(tokens = 1): ConsumeResult {
    if (!Number.isFinite(tokens) || tokens <= 0) {
      throw new RangeError(`Tokens to consume must be a positive finite number, got ${tokens}`);
    }

    this.refill();

    if (this.currentTokens >= tokens) {
      this.currentTokens -= tokens;
      const timeToNext =
        this.currentTokens < this.capacity
          ? Math.ceil(
              ((1 - (this.currentTokens % 1 || (this.currentTokens === 0 ? 0 : 1))) /
                this.refillRatePerSecond) *
                1000,
            )
          : 0;

      return {
        consumed: true,
        remainingTokens: this.currentTokens,
        timeToNextTokenMs: Math.max(0, timeToNext),
      };
    }

    const deficit = tokens - this.currentTokens;
    const timeToNextTokenMs = Math.ceil((deficit / this.refillRatePerSecond) * 1000);

    return {
      consumed: false,
      remainingTokens: this.currentTokens,
      timeToNextTokenMs: Math.max(0, timeToNextTokenMs),
    };
  }

  /**
   * Resets the bucket to full capacity at the current clock time.
   */
  reset(): void {
    this.currentTokens = this.capacity;
    this.lastRefillTimestampMs = this.clock.now().getTime();
  }
}
