import type { RateLimiter } from "@verixa/shared-kernel";
import { describe, expect, it, vi } from "vitest";

import { extractClientIp, InMemoryRateLimiter, IpRateLimitStrategy } from "./ip-strategy.js";

describe("extractClientIp", () => {
  it("returns remoteAddress directly when trustedProxyCount is 0 or unconfigured", () => {
    const request = {
      remoteAddress: "192.0.2.1",
      headers: {
        "x-forwarded-for": "203.0.113.195, 70.41.3.18",
      },
    };

    expect(extractClientIp(request)).toBe("192.0.2.1");
    expect(extractClientIp(request, { trustedProxyCount: 0 })).toBe("192.0.2.1");
  });

  it("returns remoteAddress when X-Forwarded-For is absent", () => {
    const request = { remoteAddress: "198.51.100.5" };
    expect(extractClientIp(request, { trustedProxyCount: 1 })).toBe("198.51.100.5");
  });

  it("extracts the client IP behind a single trusted reverse proxy", () => {
    // Client (203.0.113.195) -> Reverse Proxy (192.0.2.1) -> App
    const request = {
      remoteAddress: "192.0.2.1",
      headers: {
        "x-forwarded-for": "203.0.113.195",
      },
    };

    expect(extractClientIp(request, { trustedProxyCount: 1 })).toBe("203.0.113.195");
  });

  it("extracts the client IP behind two trusted proxies (e.g. CDN + Load Balancer)", () => {
    // Client (203.0.113.195) -> CDN (198.51.100.1) -> LB (192.0.2.1) -> App
    const request = {
      remoteAddress: "192.0.2.1",
      headers: {
        "x-forwarded-for": "203.0.113.195, 198.51.100.1",
      },
    };

    expect(extractClientIp(request, { trustedProxyCount: 2 })).toBe("203.0.113.195");
  });

  it("ignores spoofed X-Forwarded-For headers prepended by an untrusted client", () => {
    // Attacker (198.51.100.42) sends fake header "1.1.1.1" to trusted edge proxy (192.0.2.1)
    // Edge proxy appends real client IP: "1.1.1.1, 198.51.100.42"
    const request = {
      remoteAddress: "192.0.2.1",
      headers: {
        "x-forwarded-for": "1.1.1.1, 198.51.100.42",
      },
    };

    // With trustedProxyCount = 1, the rightmost 1 IP is the client connecting to the proxy
    expect(extractClientIp(request, { trustedProxyCount: 1 })).toBe("198.51.100.42");
  });

  it("handles spoofing through multiple untrusted hops with multiple trusted proxies", () => {
    // Attacker sends: "10.0.0.1, 10.0.0.2" to CDN (trusted proxy 2), which forwards to LB (trusted proxy 1)
    // Header arriving at App: "10.0.0.1, 10.0.0.2, 198.51.100.99, 172.16.0.5"
    const request = {
      remoteAddress: "172.16.0.5",
      headers: {
        "x-forwarded-for": "10.0.0.1, 10.0.0.2, 198.51.100.99, 172.16.0.5",
      },
    };

    expect(extractClientIp(request, { trustedProxyCount: 2 })).toBe("198.51.100.99");
  });

  it("handles array header values and whitespace", () => {
    const request = {
      remoteAddress: "127.0.0.1",
      headers: {
        "x-forwarded-for": [" 203.0.113.1 ", " 198.51.100.2 "],
      },
    };

    expect(extractClientIp(request, { trustedProxyCount: 1 })).toBe("198.51.100.2");
  });

  it("falls back to leftmost IP when header contains fewer entries than trusted proxies", () => {
    const request = {
      remoteAddress: "127.0.0.1",
      headers: {
        "x-forwarded-for": "203.0.113.55",
      },
    };

    expect(extractClientIp(request, { trustedProxyCount: 3 })).toBe("203.0.113.55");
  });
});

describe("IpRateLimitStrategy", () => {
  it("derives bucket key formatted as ip:<clientIp>", () => {
    const strategy = new IpRateLimitStrategy(new InMemoryRateLimiter(), {
      trustedProxyCount: 1,
      namespace: "tenant-1",
    });

    const key = strategy.getBucketKey(
      {
        remoteAddress: "10.0.0.1",
        headers: { "x-forwarded-for": "198.51.100.77" },
      },
      "login",
    );

    expect(key).toEqual({
      action: "login",
      identifier: "ip:198.51.100.77",
      namespace: "tenant-1",
    });
  });

  it("allows requests under the limit and tracks remaining attempts", async () => {
    const rateLimiter = new InMemoryRateLimiter(3, 60_000);
    const strategy = new IpRateLimitStrategy(rateLimiter, { trustedProxyCount: 0 });

    const request = { remoteAddress: "198.51.100.10" };

    const res1 = await strategy.check({ request, action: "login" });
    expect(res1.allowed).toBe(true);
    expect(res1.remaining).toBe(2);
    expect(res1.clientIp).toBe("198.51.100.10");
    expect(res1.strategy).toBe("ip");

    const res2 = await strategy.check({ request, action: "login" });
    expect(res2.allowed).toBe(true);
    expect(res2.remaining).toBe(1);

    const res3 = await strategy.check({ request, action: "login" });
    expect(res3.allowed).toBe(true);
    expect(res3.remaining).toBe(0);

    const res4 = await strategy.check({ request, action: "login" });
    expect(res4.allowed).toBe(false);
    expect(res4.remaining).toBe(0);
  });

  it("isolates rate limits between distinct IP addresses", async () => {
    const rateLimiter = new InMemoryRateLimiter(1, 60_000);
    const strategy = new IpRateLimitStrategy(rateLimiter, { trustedProxyCount: 0 });

    const reqA = { remoteAddress: "192.0.2.1" };
    const reqB = { remoteAddress: "192.0.2.2" };

    const firstA = await strategy.check({ request: reqA, action: "login" });
    expect(firstA.allowed).toBe(true);

    const secondA = await strategy.check({ request: reqA, action: "login" });
    expect(secondA.allowed).toBe(false);

    // IP B is unaffected by IP A's exhaustion
    const firstB = await strategy.check({ request: reqB, action: "login" });
    expect(firstB.allowed).toBe(true);
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

    const strategy = new IpRateLimitStrategy(mockLimiter, { trustedProxyCount: 0 });
    const request = { remoteAddress: "192.0.2.99" };

    await strategy.recordFailure({ request, action: "login", namespace: "auth" });
    expect(recordFailureFn).toHaveBeenCalledWith({
      action: "login",
      identifier: "ip:192.0.2.99",
      namespace: "auth",
    });

    await strategy.reset({ request, action: "login", namespace: "auth" });
    expect(resetFn).toHaveBeenCalledWith({
      action: "login",
      identifier: "ip:192.0.2.99",
      namespace: "auth",
    });
  });
});
