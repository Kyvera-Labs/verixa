import { describe, expect, it } from "vitest";

import { CaptchaTriggerPolicy } from "./captcha-trigger-policy.js";

describe("CaptchaTriggerPolicy", () => {
  it("does not require CAPTCHA challenge before threshold is met", () => {
    const policy = new CaptchaTriggerPolicy({ failureThreshold: 3 });
    const subject = { identifier: "alice@example.com", ip: "192.0.2.1" };

    expect(policy.isChallengeRequired(subject)).toBe(false);

    policy.recordFailure(subject);
    expect(policy.isChallengeRequired(subject)).toBe(false);

    policy.recordFailure(subject);
    expect(policy.isChallengeRequired(subject)).toBe(false);
  });

  it("triggers CAPTCHA challenge when failure threshold is reached on account", () => {
    const policy = new CaptchaTriggerPolicy({ failureThreshold: 3 });
    const subject = { identifier: "bob@example.com" };

    policy.recordFailure(subject);
    policy.recordFailure(subject);
    policy.recordFailure(subject);

    expect(policy.isChallengeRequired(subject)).toBe(true);
    expect(policy.getFailureCount(subject)).toBe(3);
  });

  it("triggers CAPTCHA challenge when failure threshold is reached on IP alone", () => {
    const policy = new CaptchaTriggerPolicy({ failureThreshold: 3 });
    const ip = "203.0.113.50";

    // Three distinct usernames attacked from the same abusive IP
    policy.recordFailure({ identifier: "user1@example.com", ip });
    policy.recordFailure({ identifier: "user2@example.com", ip });
    policy.recordFailure({ identifier: "user3@example.com", ip });

    // The abusive IP should now be challenged even with a 4th new username
    expect(policy.isChallengeRequired({ identifier: "user4@example.com", ip })).toBe(true);
    // Unrelated IP targeting user4 is not challenged
    expect(
      policy.isChallengeRequired({ identifier: "user4@example.com", ip: "198.51.100.1" }),
    ).toBe(false);
  });

  it("resets failure counter and clears challenge requirement on recordSuccess", () => {
    const policy = new CaptchaTriggerPolicy({ failureThreshold: 2 });
    const subject = { identifier: "carol@example.com", ip: "198.51.100.22" };

    policy.recordFailure(subject);
    policy.recordFailure(subject);
    expect(policy.isChallengeRequired(subject)).toBe(true);

    policy.recordSuccess(subject);
    expect(policy.isChallengeRequired(subject)).toBe(false);
    expect(policy.getFailureCount(subject)).toBe(0);
  });

  it("expires failures after windowMs elapses", () => {
    const windowMs = 5000;
    const policy = new CaptchaTriggerPolicy({ failureThreshold: 2, windowMs });
    const subject = "dave@example.com";
    const startTime = 1_000_000;

    policy.recordFailure(subject, startTime);
    const lastFailureTime = startTime + 1000;
    policy.recordFailure(subject, lastFailureTime);
    expect(policy.isChallengeRequired(subject, startTime + 2000)).toBe(true);

    // After windowMs from the last failure, failures expire
    expect(policy.isChallengeRequired(subject, lastFailureTime + windowMs + 100)).toBe(false);
    expect(policy.getFailureCount(subject, lastFailureTime + windowMs + 100)).toBe(0);
  });
});
