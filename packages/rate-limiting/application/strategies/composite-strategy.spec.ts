import { describe, expect, it, vi } from "vitest";

import { AccountRateLimitStrategy, InMemoryRateLimiter } from "./account-strategy.js";
import {
  CompositeRateLimitStrategy,
  type CompositeRateLimitContext,
} from "./composite-strategy.js";
import { IpRateLimitStrategy } from "./ip-strategy.js";

describe("CompositeRateLimitStrategy", () => {
  const sampleRequest = {
    remoteAddress: "203.0.113.195",
    headers: {},
  };

  const sampleContext: CompositeRateLimitContext = {
    request: sampleRequest,
    accountIdentifier: "alice@example.com",
    action: "login",
  };

  it("allows request when both IP and account strategies allow", async () => {
    const ipLimiter = new InMemoryRateLimiter(5, 60_000);
    const accountLimiter = new InMemoryRateLimiter(5, 60_000);

    const ipStrategy = new IpRateLimitStrategy(ipLimiter);
    const accountStrategy = new AccountRateLimitStrategy(accountLimiter);

    const strategy = new CompositeRateLimitStrategy({
      ipStrategy,
      accountStrategy,
    });

    const result = await strategy.check(sampleContext);

    expect(result.allowed).toBe(true);
    expect(result.deniedBy).toBeUndefined();
    expect(result.strategy).toBe("composite");
    expect(result.remaining).toBe(4);
    expect(result.ipResult.allowed).toBe(true);
    expect(result.accountResult.allowed).toBe(true);
  });

  it("denies request with deniedBy: 'ip' when IP strategy denies but account allows", async () => {
    const ipLimiter = new InMemoryRateLimiter(1, 60_000);
    const accountLimiter = new InMemoryRateLimiter(5, 60_000);

    const ipStrategy = new IpRateLimitStrategy(ipLimiter);
    const accountStrategy = new AccountRateLimitStrategy(accountLimiter);

    const strategy = new CompositeRateLimitStrategy({
      ipStrategy,
      accountStrategy,
    });

    // Exhaust IP bucket (limit is 1)
    await ipStrategy.check({ request: sampleRequest, action: "login" });

    // Now composite check should see IP exceeded, but account allowed
    const result = await strategy.check(sampleContext);

    expect(result.allowed).toBe(false);
    expect(result.deniedBy).toBe("ip");
    expect(result.ipResult.allowed).toBe(false);
    expect(result.accountResult.allowed).toBe(true);
    expect(result.remaining).toBe(0);
  });

  it("denies request with deniedBy: 'account' when account strategy denies but IP allows", async () => {
    const ipLimiter = new InMemoryRateLimiter(10, 60_000);
    const accountLimiter = new InMemoryRateLimiter(1, 60_000);

    const ipStrategy = new IpRateLimitStrategy(ipLimiter);
    const accountStrategy = new AccountRateLimitStrategy(accountLimiter);

    const strategy = new CompositeRateLimitStrategy({
      ipStrategy,
      accountStrategy,
    });

    // Exhaust account bucket (limit is 1)
    await accountStrategy.check({
      accountIdentifier: sampleContext.accountIdentifier,
      action: "login",
    });

    // Now composite check should see account exceeded, but IP allowed
    const result = await strategy.check(sampleContext);

    expect(result.allowed).toBe(false);
    expect(result.deniedBy).toBe("account");
    expect(result.ipResult.allowed).toBe(true);
    expect(result.accountResult.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("denies request with deniedBy: 'both' when both IP and account strategies deny", async () => {
    const ipLimiter = new InMemoryRateLimiter(1, 60_000);
    const accountLimiter = new InMemoryRateLimiter(1, 60_000);

    const ipStrategy = new IpRateLimitStrategy(ipLimiter);
    const accountStrategy = new AccountRateLimitStrategy(accountLimiter);

    const strategy = new CompositeRateLimitStrategy({
      ipStrategy,
      accountStrategy,
    });

    // Consume first token (allowed: true on both)
    const firstResult = await strategy.check(sampleContext);
    expect(firstResult.allowed).toBe(true);

    // Consume second token (both limit 1 exceeded -> both deny)
    const secondResult = await strategy.check(sampleContext);

    expect(secondResult.allowed).toBe(false);
    expect(secondResult.deniedBy).toBe("both");
    expect(secondResult.ipResult.allowed).toBe(false);
    expect(secondResult.accountResult.allowed).toBe(false);
  });

  it("calculates conservative remaining and max resetAt across sub-strategies", async () => {
    const mockIpCheck = vi.fn().mockResolvedValue({
      allowed: true,
      remaining: 8,
      limit: 10,
      resetAt: 1000,
    });
    const mockAccountCheck = vi.fn().mockResolvedValue({
      allowed: true,
      remaining: 2,
      limit: 5,
      resetAt: 2500,
    });

    const ipStrategy = {
      resolveClientIp: vi.fn().mockReturnValue("1.2.3.4"),
      check: mockIpCheck,
      recordFailure: vi.fn(),
      reset: vi.fn(),
    } as unknown as IpRateLimitStrategy;

    const accountStrategy = {
      check: mockAccountCheck,
      recordFailure: vi.fn(),
      reset: vi.fn(),
    } as unknown as AccountRateLimitStrategy;

    const strategy = new CompositeRateLimitStrategy({
      ipStrategy,
      accountStrategy,
    });

    const result = await strategy.check(sampleContext);

    expect(result.remaining).toBe(2); // min(8, 2)
    expect(result.limit).toBe(5); // min(10, 5)
    expect(result.resetAt).toBe(2500); // max(1000, 2500)
  });

  it("delegates recordFailure to both IP and account sub-strategies", async () => {
    const mockIpRecord = vi.fn().mockResolvedValue(undefined);
    const mockAccountRecord = vi.fn().mockResolvedValue(undefined);

    const ipStrategy = {
      resolveClientIp: vi.fn().mockReturnValue("203.0.113.195"),
      check: vi.fn(),
      recordFailure: mockIpRecord,
      reset: vi.fn(),
    } as unknown as IpRateLimitStrategy;

    const accountStrategy = {
      check: vi.fn(),
      recordFailure: mockAccountRecord,
      reset: vi.fn(),
    } as unknown as AccountRateLimitStrategy;

    const strategy = new CompositeRateLimitStrategy({
      ipStrategy,
      accountStrategy,
    });

    await strategy.recordFailure(sampleContext);

    expect(mockIpRecord).toHaveBeenCalledTimes(1);
    expect(mockAccountRecord).toHaveBeenCalledTimes(1);
    expect(mockAccountRecord).toHaveBeenCalledWith({
      accountIdentifier: "alice@example.com",
      clientIp: "203.0.113.195",
      action: "login",
    });
  });

  it("delegates reset to both IP and account sub-strategies", async () => {
    const mockIpReset = vi.fn().mockResolvedValue(undefined);
    const mockAccountReset = vi.fn().mockResolvedValue(undefined);

    const ipStrategy = {
      resolveClientIp: vi.fn().mockReturnValue("203.0.113.195"),
      check: vi.fn(),
      recordFailure: vi.fn(),
      reset: mockIpReset,
    } as unknown as IpRateLimitStrategy;

    const accountStrategy = {
      check: vi.fn(),
      recordFailure: vi.fn(),
      reset: mockAccountReset,
    } as unknown as AccountRateLimitStrategy;

    const strategy = new CompositeRateLimitStrategy({
      ipStrategy,
      accountStrategy,
    });

    await strategy.reset(sampleContext);

    expect(mockIpReset).toHaveBeenCalledTimes(1);
    expect(mockAccountReset).toHaveBeenCalledTimes(1);
    expect(mockAccountReset).toHaveBeenCalledWith({
      accountIdentifier: "alice@example.com",
      clientIp: "203.0.113.195",
      action: "login",
    });
  });

  it("can be constructed with default options without passing strategies explicitly", async () => {
    const strategy = new CompositeRateLimitStrategy();
    const result = await strategy.check(sampleContext);

    expect(result.allowed).toBe(true);
    expect(result.strategy).toBe("composite");
  });
});
