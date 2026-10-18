import { describe, expect, it } from "vitest";

import { InMemoryBruteForceAttemptStore } from "../../infrastructure/in-memory-brute-force-attempt-store.js";
import type { RateLimitDecision, RateLimiter } from "../ports/rate-limiter.js";

import { BruteForcePolicy, DEFAULT_BRUTE_FORCE_THRESHOLDS } from "./brute-force-policy.js";

/**
 * A 60s window for most of these tests: long enough that nothing here has to
 * sleep, short enough that the arithmetic is legible. The one test that needs
 * time to pass uses a 1ms window and waits it out.
 */
function policyWith(overrides: Partial<typeof DEFAULT_BRUTE_FORCE_THRESHOLDS> = {}) {
  const store = new InMemoryBruteForceAttemptStore();
  const policy = new BruteForcePolicy(store, { ...DEFAULT_BRUTE_FORCE_THRESHOLDS, ...overrides });
  return { store, policy };
}

function limiterReturning(decision: RateLimitDecision): RateLimiter {
  return { check: () => Promise.resolve(decision) };
}

/** A limiter that counts calls, so a test can assert asking is not spending. */
function countingLimiter(decision: RateLimitDecision = { allowed: true }) {
  let calls = 0;
  const limiter: RateLimiter = {
    check: () => {
      calls += 1;
      return Promise.resolve(decision);
    },
  };
  return {
    get calls() {
      return calls;
    },
    limiter,
  };
}

describe("BruteForcePolicy.key", () => {
  const SCOPES = ["login", "mfa", "password-reset", "api-key"] as const;

  it.each(SCOPES)("names the %s bucket with its scope", (scope) => {
    expect(BruteForcePolicy.key(scope, "user@example.com")).toBe(`${scope}:user@example.com`);
  });

  it("normalises case and surrounding space", () => {
    // Same budget for the same attacker making the same typing mistake. This is
    // deliberately *not* address canonicalisation — see the method.
    expect(BruteForcePolicy.key("login", "  Admin@Example.COM ")).toBe(
      BruteForcePolicy.key("login", "admin@example.com"),
    );
  });

  it("keeps every scope's budget separate", async () => {
    const { policy } = policyWith({ threshold: 1 });
    const identifier = "shared@example.com";

    await policy.recordFailure("login", identifier);

    expect((await policy.check("login", identifier)).allowed).toBe(false);
    // An exhausted login budget must not refuse an MFA challenge or an API-key
    // call for the same person: those are different secrets with different
    // recovery paths, and one counter covering all three is a self-inflicted
    // denial of service.
    for (const scope of SCOPES.filter((candidate) => candidate !== "login")) {
      expect((await policy.check(scope, identifier)).allowed).toBe(true);
    }
  });
});

describe("thresholds and backoff", () => {
  it("allows failures up to the threshold and refuses from it", async () => {
    const { policy } = policyWith({ threshold: 3 });
    const identifier = "a@example.com";

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await policy.recordFailure("login", identifier);
      expect((await policy.check("login", identifier)).allowed).toBe(true);
    }

    await policy.recordFailure("login", identifier);
    const decision = await policy.check("login", identifier);

    expect(decision.allowed).toBe(false);
    expect(decision.source).toBe("lockout");
    expect(decision.retryAfterSeconds).toBe(60);
  });

  it("doubles the refusal per failure past the threshold, up to the cap", async () => {
    const { policy } = policyWith({
      threshold: 2,
      baseDurationMs: 10_000,
      maxDurationMs: 40_000,
    });
    const identifier = "b@example.com";
    const step = async () => {
      await policy.recordFailure("login", identifier);
      return (await policy.check("login", identifier)).retryAfterSeconds;
    };

    expect(await step()).toBeUndefined(); // one failure: below the threshold
    expect(await step()).toBe(10); // at it
    expect(await step()).toBe(20);
    expect(await step()).toBe(40);
    // The cap is what stops lockout becoming a weapon against the account
    // holder: an attacker can raise the wall, but not to a year.
    for (let i = 0; i < 8; i += 1) await step();
    expect(await step()).toBe(40);
  });

  it("refuses a runaway counter without overflowing the window", async () => {
    // Past ~64 steps, `base * factor ** steps` is Infinity and
    // `new Date(Infinity)` is an Invalid Date — which a store would persist as
    // "never locked", unlocking the account it was supposed to protect.
    const { store, policy } = policyWith({ threshold: 1 });
    const identifier = "c@example.com";

    for (let i = 0; i < 80; i += 1) await policy.recordFailure("login", identifier);

    const record = await store.read(BruteForcePolicy.key("login", identifier));
    expect(record.lockedUntil).toBeInstanceOf(Date);
    expect(Number.isNaN(record.lockedUntil?.getTime() ?? NaN)).toBe(false);
    expect((await policy.check("login", identifier)).allowed).toBe(false);
  });

  it("uses the same numbers as the per-credential lockout policy", () => {
    // A guard against drift, not a restatement of taste. These are the values
    // of `DEFAULT_LOCKOUT_POLICY` in `@verixa/credentials`; if one side changes
    // alone, the effective policy for a login becomes whichever is looser,
    // silently, and nothing but this assertion would notice.
    expect(DEFAULT_BRUTE_FORCE_THRESHOLDS).toEqual({
      threshold: 5,
      baseDurationMs: 60_000,
      backoffFactor: 2,
      maxDurationMs: 3_600_000,
    });
  });
});

describe("windows and resetting", () => {
  it("forgets the counter once the window has elapsed", async () => {
    const { store, policy } = policyWith({ threshold: 2, baseDurationMs: 1 });
    const identifier = "d@example.com";

    await policy.recordFailure("login", identifier);
    await policy.recordFailure("login", identifier);
    expect((await policy.check("login", identifier)).allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 5));

    expect((await policy.check("login", identifier)).allowed).toBe(true);
    // Cleared, not merely expired: the next failure is a first failure again,
    // so the threshold counts a run rather than a lifetime total.
    expect((await store.read(BruteForcePolicy.key("login", identifier))).failedAttempts).toBe(0);
  });

  it("clears the budget on a successful attempt", async () => {
    const { store, policy } = policyWith();
    const identifier = "e@example.com";

    await policy.recordFailure("login", identifier);
    await policy.recordSuccess("login", identifier);

    expect((await store.read(BruteForcePolicy.key("login", identifier))).failedAttempts).toBe(0);
    expect((await policy.check("login", identifier)).allowed).toBe(true);
  });

  it("does not climb the backoff ladder for asking", async () => {
    // `check` is read-only. A refusal that also recorded a failure would let an
    // attacker who is already locked out keep lengthening their own lock by
    // retrying, which is the opposite of what the counter measures.
    const { store, policy } = policyWith({ threshold: 1 });
    const identifier = "f@example.com";

    await policy.recordFailure("login", identifier);
    for (let i = 0; i < 20; i += 1) {
      expect((await policy.check("login", identifier)).allowed).toBe(false);
    }

    expect((await store.read(BruteForcePolicy.key("login", identifier))).failedAttempts).toBe(1);
  });
});

describe("composition with a rate limiter", () => {
  it("allows when both gates allow, and asking costs nothing", async () => {
    const limiter = countingLimiter({ allowed: true });
    const policy = new BruteForcePolicy(
      new InMemoryBruteForceAttemptStore(),
      DEFAULT_BRUTE_FORCE_THRESHOLDS,
      limiter.limiter,
    );

    expect((await policy.check("api-key", "key-1")).allowed).toBe(true);
    expect(limiter.calls).toBe(1);
  });

  it("refuses on the limiter alone when nothing is locked", async () => {
    const policy = new BruteForcePolicy(
      new InMemoryBruteForceAttemptStore(),
      DEFAULT_BRUTE_FORCE_THRESHOLDS,
      limiterReturning({ allowed: false, retryAfterSeconds: 30 }),
    );

    const decision = await policy.check("api-key", "key-1");

    expect(decision.allowed).toBe(false);
    expect(decision.source).toBe("rate-limit");
    expect(decision.retryAfterSeconds).toBe(30);
  });

  it("refuses when either gate refuses and reports the longer wait", async () => {
    const store = new InMemoryBruteForceAttemptStore();
    const thresholds = { ...DEFAULT_BRUTE_FORCE_THRESHOLDS, threshold: 1 };
    // The default window is 60s, so a locked key plus a 5s limiter answer must
    // come back as 60: telling the caller 5 would produce a retry that is
    // refused again for another 55 seconds.
    await new BruteForcePolicy(store, thresholds).recordFailure("mfa", "g@example.com");

    const policy = new BruteForcePolicy(
      store,
      thresholds,
      limiterReturning({ allowed: false, retryAfterSeconds: 5 }),
    );
    const decision = await policy.check("mfa", "g@example.com");

    expect(decision.allowed).toBe(false);
    expect(decision.source).toBe("both");
    expect(decision.retryAfterSeconds).toBe(60);
  });

  it("omits a retry window it does not have", async () => {
    const policy = new BruteForcePolicy(
      new InMemoryBruteForceAttemptStore(),
      DEFAULT_BRUTE_FORCE_THRESHOLDS,
      limiterReturning({ allowed: false }),
    );

    const decision = await policy.check("password-reset", "token-digest");

    expect(decision.allowed).toBe(false);
    // Absent, not zero: a caller that surfaces this must not promise admission
    // in 0 seconds when the limiter has no idea.
    expect(decision.retryAfterSeconds).toBeUndefined();
  });
});
