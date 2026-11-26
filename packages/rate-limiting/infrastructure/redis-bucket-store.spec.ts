import type { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";

import { RedisBucketStore } from "./redis-bucket-store.js";
import { startTestRedis } from "./testing/redis-harness.js";

/**
 * In-memory Mock Redis implementing eval and basic hash/expire operations
 * for fast deterministic tests that run even when Docker is unavailable.
 */
class InMemoryMockRedis {
  private hashes = new Map<string, Map<string, string>>();
  private ttls = new Map<string, number>();

  async eval(
    _script: string,
    _numKeys: number,
    key: string,
    capacityStr: string,
    refillRateStr: string,
    requestedStr: string,
    nowMsStr: string,
    ttlSecondsStr: string,
  ): Promise<[number, string, number]> {
    await Promise.resolve();
    const capacity = Number.parseFloat(capacityStr);
    const refillRate = Number.parseFloat(refillRateStr);
    const requested = Number.parseFloat(requestedStr);
    const nowMs = Number.parseInt(nowMsStr, 10);
    const ttlSeconds = Number.parseInt(ttlSecondsStr, 10);

    let hash = this.hashes.get(key);
    let currentTokens: number;
    let lastRefillMs: number;

    if (!hash || !hash.has("tokens")) {
      currentTokens = capacity;
      lastRefillMs = nowMs;
      hash = new Map<string, string>();
      this.hashes.set(key, hash);
    } else {
      currentTokens = Number.parseFloat(hash.get("tokens")!);
      lastRefillMs = Number.parseInt(hash.get("last_refill")!, 10);

      if (nowMs > lastRefillMs) {
        const elapsed = nowMs - lastRefillMs;
        const refilled = (elapsed / 1000) * refillRate;
        currentTokens = Math.min(capacity, currentTokens + refilled);
        lastRefillMs = nowMs;
      }
    }

    // Assigned on every branch below.
    let allowed: number;
    let timeToNextMs: number;

    if (currentTokens >= requested) {
      allowed = 1;
      currentTokens -= requested;
      if (currentTokens < capacity) {
        const frac = currentTokens % 1;
        const needed = 1.0 - frac;
        timeToNextMs = Math.ceil((needed / refillRate) * 1000);
      } else {
        timeToNextMs = 0;
      }
    } else {
      allowed = 0;
      const deficit = requested - currentTokens;
      timeToNextMs = Math.ceil((deficit / refillRate) * 1000);
    }

    hash.set("tokens", currentTokens.toString());
    hash.set("last_refill", lastRefillMs.toString());
    this.ttls.set(key, ttlSeconds);

    return [allowed, currentTokens.toString(), timeToNextMs];
  }

  async hmget(key: string, ...fields: string[]): Promise<(string | null)[]> {
    await Promise.resolve();
    const hash = this.hashes.get(key);
    if (!hash) {
      return fields.map(() => null);
    }
    return fields.map((f) => hash.get(f) ?? null);
  }

  async del(key: string): Promise<number> {
    await Promise.resolve();
    const existed = this.hashes.delete(key);
    this.ttls.delete(key);
    return existed ? 1 : 0;
  }

  getTtl(key: string): number | undefined {
    return this.ttls.get(key);
  }
}

describe("RedisBucketStore (Unit with Mock Redis)", () => {
  it("formats keys according to ratelimit:{scope}:{key}", () => {
    const mock = new InMemoryMockRedis() as unknown as Redis;
    const store = new RedisBucketStore(mock);

    expect(store.buildKey("login", "192.168.1.1")).toBe("ratelimit:login:192.168.1.1");
    expect(store.buildKey("register", "user@example.com")).toBe(
      "ratelimit:register:user@example.com",
    );
  });

  it("respects custom keyPrefix", () => {
    const mock = new InMemoryMockRedis() as unknown as Redis;
    const store = new RedisBucketStore(mock, { keyPrefix: "custom:" });

    expect(store.buildKey("auth", "key123")).toBe("custom:auth:key123");
  });

  it("consumes tokens and sets key TTL", async () => {
    const mock = new InMemoryMockRedis();
    const store = new RedisBucketStore(mock as unknown as Redis, { defaultTtlSeconds: 120 });

    const result = await store.consume({
      scope: "login",
      key: "user-1",
      capacity: 5,
      refillRatePerSecond: 1,
      requested: 2,
      nowMs: 10_000,
    });

    expect(result.allowed).toBe(true);
    expect(result.remainingTokens).toBe(3);
    expect(mock.getTtl("ratelimit:login:user-1")).toBeGreaterThan(0);
  });

  it("exhausts tokens and returns timeToNextTokenMs", async () => {
    const mock = new InMemoryMockRedis();
    const store = new RedisBucketStore(mock as unknown as Redis);

    // Consume all 3 tokens
    await store.consume({
      scope: "api",
      key: "ip-1",
      capacity: 3,
      refillRatePerSecond: 1,
      requested: 3,
      nowMs: 1000,
    });

    // Next request should fail
    const result = await store.consume({
      scope: "api",
      key: "ip-1",
      capacity: 3,
      refillRatePerSecond: 1,
      requested: 1,
      nowMs: 1000,
    });

    expect(result.allowed).toBe(false);
    expect(result.remainingTokens).toBe(0);
    expect(result.timeToNextTokenMs).toBe(1000);
  });

  it("refills proportionally as time progresses", async () => {
    const mock = new InMemoryMockRedis();
    const store = new RedisBucketStore(mock as unknown as Redis);

    await store.consume({
      scope: "api",
      key: "client-a",
      capacity: 10,
      refillRatePerSecond: 2,
      requested: 10,
      nowMs: 1000,
    });

    // 2 seconds later -> 4 tokens refilled
    const available = await store.getTokens("api", "client-a", 10, 2, 3000);
    expect(available).toBe(4);

    const result = await store.consume({
      scope: "api",
      key: "client-a",
      capacity: 10,
      refillRatePerSecond: 2,
      requested: 3,
      nowMs: 3000,
    });
    expect(result.allowed).toBe(true);
    expect(result.remainingTokens).toBe(1);
  });

  it("resets rate limit state", async () => {
    const mock = new InMemoryMockRedis();
    const store = new RedisBucketStore(mock as unknown as Redis);

    await store.consume({
      scope: "login",
      key: "target",
      capacity: 5,
      refillRatePerSecond: 1,
      requested: 5,
      nowMs: 1000,
    });

    await store.reset("login", "target");
    const tokens = await store.getTokens("login", "target", 5, 1, 1000);
    expect(tokens).toBe(5);
  });

  it("concurrency race test: never over-grants tokens under simultaneous requests", async () => {
    const mock = new InMemoryMockRedis();
    const store = new RedisBucketStore(mock as unknown as Redis);

    const capacity = 10;
    const totalRequests = 50;

    // Dispatch 50 concurrent requests simultaneously at the exact same timestamp
    const promises = Array.from({ length: totalRequests }, () =>
      store.consume({
        scope: "race",
        key: "concurrent-client",
        capacity,
        refillRatePerSecond: 1,
        requested: 1,
        nowMs: 5000,
      }),
    );

    const results = await Promise.all(promises);
    const allowedCount = results.filter((r) => r.allowed).length;
    const deniedCount = results.filter((r) => !r.allowed).length;

    expect(allowedCount).toBe(capacity);
    expect(deniedCount).toBe(totalRequests - capacity);
  });

  it("throws on invalid parameters and supports reset", async () => {
    const mock = new InMemoryMockRedis();
    const store = new RedisBucketStore(mock as unknown as Redis);

    await expect(
      store.consume({
        scope: "api",
        key: "k",
        capacity: 5,
        refillRatePerSecond: 0,
      }),
    ).rejects.toThrow(/Refill rate must be > 0/);

    await expect(
      store.consume({
        scope: "api",
        key: "k",
        capacity: 5,
        refillRatePerSecond: 1,
        requested: 0,
      }),
    ).rejects.toThrow(/Requested tokens must be > 0/);

    await store.reset("api", "k");
  });
});

const redis = await startTestRedis();

const testRealRedis = redis ? describe : describe.skip;

testRealRedis("RedisBucketStore (Real Redis)", () => {
  const testRedis = redis!;
  let store: RedisBucketStore;

  afterAll(async () => {
    await testRedis.stop();
  });

  it("executes atomic Lua script on real Redis and respects capacity", async () => {
    store = new RedisBucketStore(testRedis.client);
    const uniqueKey = `test-${Date.now()}`;
    const result = await store.consume({
      scope: "real-test",
      key: uniqueKey,
      capacity: 5,
      refillRatePerSecond: 2,
      requested: 3,
    });

    expect(result.allowed).toBe(true);
    expect(result.remainingTokens).toBe(2);

    await store.reset("real-test", uniqueKey);
  });

  it("never over-grants tokens under concurrency against real Redis", async () => {
    store = new RedisBucketStore(testRedis.client);
    const uniqueKey = `concurrent-${Date.now()}`;
    const capacity = 5;
    const requests = 20;

    const promises = Array.from({ length: requests }, () =>
      store.consume({
        scope: "real-race",
        key: uniqueKey,
        capacity,
        refillRatePerSecond: 0.1, // slow refill to prevent refills during the burst
        requested: 1,
      }),
    );

    const results = await Promise.all(promises);
    const allowedCount = results.filter((r) => r.allowed).length;

    expect(allowedCount).toBe(capacity);
    await store.reset("real-race", uniqueKey);
  });
});
