import { describe, expect, it } from "vitest";

import { TokenBucket, type Clock } from "./token-bucket.js";

class MockClock implements Clock {
  constructor(private timeMs: number) {}

  now(): Date {
    return new Date(this.timeMs);
  }

  advance(ms: number): void {
    this.timeMs += ms;
  }

  set(timeMs: number): void {
    this.timeMs = timeMs;
  }
}

describe("TokenBucket (domain)", () => {
  it("initializes with full capacity by default", () => {
    const clock = new MockClock(1000);
    const bucket = new TokenBucket({
      capacity: 10,
      refillRatePerSecond: 2,
      clock,
    });

    expect(bucket.getCapacity()).toBe(10);
    expect(bucket.getRefillRatePerSecond()).toBe(2);
    expect(bucket.getAvailableTokens()).toBe(10);
    expect(bucket.getLastRefillAt().getTime()).toBe(1000);
  });

  it("respects custom initialTokens", () => {
    const clock = new MockClock(1000);
    const bucket = new TokenBucket({
      capacity: 10,
      refillRatePerSecond: 2,
      initialTokens: 4,
      clock,
    });

    expect(bucket.getAvailableTokens()).toBe(4);
  });

  it("clamps initialTokens between 0 and capacity", () => {
    const clock = new MockClock(1000);
    const bucketOver = new TokenBucket({
      capacity: 10,
      refillRatePerSecond: 2,
      initialTokens: 50,
      clock,
    });
    expect(bucketOver.getAvailableTokens()).toBe(10);

    const bucketUnder = new TokenBucket({
      capacity: 10,
      refillRatePerSecond: 2,
      initialTokens: -5,
      clock,
    });
    expect(bucketUnder.getAvailableTokens()).toBe(0);
  });

  it("consumes single and multiple tokens within capacity (burst consumption)", () => {
    const clock = new MockClock(1000);
    const bucket = new TokenBucket({
      capacity: 5,
      refillRatePerSecond: 1,
      clock,
    });

    const res1 = bucket.tryConsume(2);
    expect(res1.consumed).toBe(true);
    expect(res1.remainingTokens).toBe(3);

    const res2 = bucket.tryConsume(3);
    expect(res2.consumed).toBe(true);
    expect(res2.remainingTokens).toBe(0);
  });

  it("rejects consumption when requested tokens exceed available tokens (exhaustion)", () => {
    const clock = new MockClock(1000);
    const bucket = new TokenBucket({
      capacity: 2,
      refillRatePerSecond: 1,
      clock,
    });

    const res1 = bucket.tryConsume(2);
    expect(res1.consumed).toBe(true);
    expect(res1.remainingTokens).toBe(0);

    const res2 = bucket.tryConsume(1);
    expect(res2.consumed).toBe(false);
    expect(res2.remainingTokens).toBe(0);
    expect(res2.timeToNextTokenMs).toBe(1000); // 1 token deficit at 1 token/sec = 1000ms
  });

  it("calculates timeToNextTokenMs proportional to token deficit", () => {
    const clock = new MockClock(1000);
    const bucket = new TokenBucket({
      capacity: 10,
      refillRatePerSecond: 2, // 2 tokens per 1000ms = 1 token per 500ms
      initialTokens: 0,
      clock,
    });

    const res = bucket.tryConsume(3);
    expect(res.consumed).toBe(false);
    // Deficit of 3 tokens at 2 tokens/s -> 3 / 2 * 1000 = 1500ms
    expect(res.timeToNextTokenMs).toBe(1500);
  });

  it("refills proportionally over elapsed time", () => {
    const clock = new MockClock(0);
    const bucket = new TokenBucket({
      capacity: 10,
      refillRatePerSecond: 2,
      clock,
    });

    expect(bucket.tryConsume(10).consumed).toBe(true);
    expect(bucket.getAvailableTokens()).toBe(0);

    // Advance 1 second -> should refill 2 tokens
    clock.advance(1000);
    expect(bucket.getAvailableTokens()).toBe(2);

    // Advance another 2.5 seconds (2500ms) -> should refill 5 more tokens (total 7)
    clock.advance(2500);
    expect(bucket.getAvailableTokens()).toBe(7);

    // Advance 5 more seconds -> should cap at 10
    clock.advance(5000);
    expect(bucket.getAvailableTokens()).toBe(10);
  });

  it("handles fractional tokens accurately", () => {
    const clock = new MockClock(0);
    const bucket = new TokenBucket({
      capacity: 10,
      refillRatePerSecond: 1,
      clock,
    });

    bucket.tryConsume(10);
    expect(bucket.getAvailableTokens()).toBe(0);

    // 500ms elapsed -> 0.5 tokens
    clock.advance(500);
    expect(bucket.getAvailableTokens()).toBe(0.5);

    // Not enough for 1 token
    const res = bucket.tryConsume(1);
    expect(res.consumed).toBe(false);
    expect(res.remainingTokens).toBe(0.5);
    expect(res.timeToNextTokenMs).toBe(500);

    // Advance another 500ms -> 1.0 token total
    clock.advance(500);
    const resSuccess = bucket.tryConsume(1);
    expect(resSuccess.consumed).toBe(true);
    expect(resSuccess.remainingTokens).toBe(0);
  });

  it("resets to full capacity", () => {
    const clock = new MockClock(1000);
    const bucket = new TokenBucket({
      capacity: 5,
      refillRatePerSecond: 1,
      clock,
    });

    bucket.tryConsume(5);
    expect(bucket.getAvailableTokens()).toBe(0);

    bucket.reset();
    expect(bucket.getAvailableTokens()).toBe(5);
  });

  it("validates constructor options and consumption arguments", () => {
    expect(() => new TokenBucket({ capacity: 0, refillRatePerSecond: 1 })).toThrow(RangeError);
    expect(() => new TokenBucket({ capacity: -5, refillRatePerSecond: 1 })).toThrow(RangeError);
    expect(() => new TokenBucket({ capacity: NaN, refillRatePerSecond: 1 })).toThrow(RangeError);
    expect(() => new TokenBucket({ capacity: 10, refillRatePerSecond: 0 })).toThrow(RangeError);
    expect(() => new TokenBucket({ capacity: 10, refillRatePerSecond: -2 })).toThrow(RangeError);
    expect(
      () => new TokenBucket({ capacity: 10, refillRatePerSecond: 1, initialTokens: NaN }),
    ).toThrow(RangeError);

    const bucket = new TokenBucket({ capacity: 5, refillRatePerSecond: 1 });
    expect(() => bucket.tryConsume(0)).toThrow(RangeError);
    expect(() => bucket.tryConsume(-1)).toThrow(RangeError);
    expect(() => bucket.tryConsume(NaN)).toThrow(RangeError);
  });
});
