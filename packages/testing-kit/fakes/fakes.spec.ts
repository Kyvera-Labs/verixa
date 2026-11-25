import type { RateLimitKey } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import {
  InMemoryApiKeyRepository,
  InMemoryCaptchaValidator,
  InMemoryCredentialRepository,
  InMemoryInvitationRepository,
  InMemoryOrganizationMembershipRepository,
  InMemoryOrganizationRepository,
  InMemoryRateLimiter,
  InMemorySessionRepository,
  InMemoryUserRepository,
  NoopCaptchaValidator,
} from "./index.js";

describe("testing-kit fakes (in-memory test doubles)", () => {
  it("InMemoryRateLimiter enforces limit, records failures, and resets cleanly", async () => {
    const limiter = new InMemoryRateLimiter(2);
    const key: RateLimitKey = { action: "login", identifier: "user-1", namespace: "auth" };

    const first = await limiter.check(key);
    expect(first.allowed).toBe(true);
    expect(limiter.getCallCount(key)).toBe(1);

    await limiter.recordFailure(key);
    expect(limiter.getCallCount(key)).toBe(2);

    const third = await limiter.check(key);
    expect(third.allowed).toBe(false);
    expect(third.remaining).toBe(0);

    limiter.setMaxAllowed(5);
    const fourth = await limiter.check(key);
    expect(fourth.allowed).toBe(true);

    await limiter.reset(key);
    expect(limiter.getCallCount(key)).toBe(0);

    await limiter.check(key);
    await limiter.reset();
    expect(limiter.getCallCount(key)).toBe(0);

    await limiter.check(key);
    limiter.clear();
    expect(limiter.getCallCount(key)).toBe(0);
  });

  it("InMemoryCaptchaValidator satisfies verification and reset contract", async () => {
    const captcha = new InMemoryCaptchaValidator(false);
    expect(await captcha.verify("token-123")).toBe(false);

    captcha.allowToken("token-123");
    expect(await captcha.verify("token-123")).toBe(true);

    captcha.setDefaultResponse(true);
    expect(await captcha.verify("unrecognized-token")).toBe(true);

    captcha.reset();
    expect(await captcha.verify("token-123")).toBe(true); // default resets to true

    captcha.clear();
    expect(await captcha.verify("token-123")).toBe(true);

    expect(new NoopCaptchaValidator()).toBeDefined();
  });

  it("re-exports all core in-memory repositories conforming to InMemory<Port>", () => {
    expect(new InMemoryUserRepository()).toBeDefined();
    expect(new InMemoryOrganizationRepository()).toBeDefined();
    expect(new InMemoryOrganizationMembershipRepository()).toBeDefined();
    expect(new InMemoryInvitationRepository()).toBeDefined();
    expect(new InMemoryApiKeyRepository()).toBeDefined();
    expect(new InMemorySessionRepository()).toBeDefined();
    expect(new InMemoryCredentialRepository()).toBeDefined();
  });
});
