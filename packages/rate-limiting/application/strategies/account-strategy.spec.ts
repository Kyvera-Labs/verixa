import type { RateLimiter } from "@verixa/shared-kernel";
import { describe, expect, it, vi } from "vitest";

import {
  AccountRateLimitStrategy,
  InMemoryRateLimiter,
  normalizeAccountIdentifier,
} from "./account-strategy.js";

describe("normalizeAccountIdentifier", () => {
  it("lowercases and trims email identifiers", () => {
    expect(normalizeAccountIdentifier("  User.Name@Example.COM  ")).toBe("user.name@example.com");
  });

  it("trims non-email identifiers preserving casing", () => {
    expect(normalizeAccountIdentifier("  user_abc123XYZ  ")).toBe("user_abc123XYZ");
  });
});

describe("AccountRateLimitStrategy", () => {
  it("derives bucket key formatted as account:<normalizedIdentifier>", () => {
    const strategy = new AccountRateLimitStrategy(new InMemoryRateLimiter(), {
      namespace: "prod",
    });

    const key = strategy.getBucketKey("  Admin@Domain.org  ", "login");
    expect(key).toEqual({
      action: "login",
      identifier: "account:admin@domain.org",
      namespace: "prod",
    });
  });

  it("throttles credential-stuffing attacks distributed across multiple IPs targeting the same account", async () => {
    // Limit is 3 attempts per window
    const limiter = new InMemoryRateLimiter(3, 60_000);
    const strategy = new AccountRateLimitStrategy(limiter);

    const targetAccount = "victim@example.com";
    const attackIps = [
      "198.51.100.1",
      "198.51.100.2",
      "198.51.100.3",
      "198.51.100.4",
      "198.51.100.5",
    ] as const;

    // Attempt 1 from IP 1: allowed
    const r1 = await strategy.check({
      accountIdentifier: targetAccount,
      clientIp: attackIps[0],
      action: "login",
    });
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);
    expect(r1.accountIdentifier).toBe(targetAccount);
    expect(r1.strategy).toBe("account");

    // Attempt 2 from IP 2: allowed
    const r2 = await strategy.check({
      accountIdentifier: targetAccount,
      clientIp: attackIps[1],
      action: "login",
    });
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);

    // Attempt 3 from IP 3: allowed (exhausts limit)
    const r3 = await strategy.check({
      accountIdentifier: targetAccount,
      clientIp: attackIps[2],
      action: "login",
    });
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);

    // Attempt 4 from IP 4 (different IP): throttled!
    const r4 = await strategy.check({
      accountIdentifier: targetAccount,
      clientIp: attackIps[3],
      action: "login",
    });
    expect(r4.allowed).toBe(false);
    expect(r4.remaining).toBe(0);

    // Attempt 5 from IP 5 (yet another IP): also throttled!
    const r5 = await strategy.check({
      accountIdentifier: targetAccount,
      clientIp: attackIps[4],
      action: "login",
    });
    expect(r5.allowed).toBe(false);
  });

  it("leaves unrelated accounts unaffected when one account is exhausted", async () => {
    const limiter = new InMemoryRateLimiter(2, 60_000);
    const strategy = new AccountRateLimitStrategy(limiter);

    // Exhaust victim account
    await strategy.check({ accountIdentifier: "victim@example.com", action: "login" });
    await strategy.check({ accountIdentifier: "victim@example.com", action: "login" });
    const victimDenied = await strategy.check({
      accountIdentifier: "victim@example.com",
      action: "login",
    });
    expect(victimDenied.allowed).toBe(false);

    // Innocent account has independent tokens
    const innocentAllowed = await strategy.check({
      accountIdentifier: "innocent@example.com",
      action: "login",
    });
    expect(innocentAllowed.allowed).toBe(true);
    expect(innocentAllowed.remaining).toBe(1);
  });

  it("delegates recordFailure and reset to the rate limiter", async () => {
    const checkFn = vi.fn();
    const recordFailureFn = vi.fn().mockResolvedValue(undefined);
    const resetFn = vi.fn().mockResolvedValue(undefined);

    const mockLimiter: RateLimiter = {
      check: checkFn,
      recordFailure: recordFailureFn,
      reset: resetFn,
    };

    const strategy = new AccountRateLimitStrategy(mockLimiter);
    await strategy.recordFailure({
      accountIdentifier: "user@test.org",
      action: "login",
      namespace: "auth",
    });
    expect(recordFailureFn).toHaveBeenCalledWith({
      action: "login",
      identifier: "account:user@test.org",
      namespace: "auth",
    });

    await strategy.reset({
      accountIdentifier: "user@test.org",
      action: "login",
      namespace: "auth",
    });
    expect(resetFn).toHaveBeenCalledWith({
      action: "login",
      identifier: "account:user@test.org",
      namespace: "auth",
    });
  });
});
