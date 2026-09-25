import { asId } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import { MfaMethod } from "./mfa-method.js";

describe("MfaMethod", () => {
  const userId = asId<"UserId">("user-1");

  it("creates a pending method and transitions to active", () => {
    const now = new Date();
    const method = MfaMethod.createPending(userId, "webauthn", now);

    expect(method.id).toBeDefined();
    expect(method.userId).toBe(userId);
    expect(method.type).toBe("webauthn");
    expect(method.status).toBe("pending");
    expect(method.failedAttempts).toBe(0);

    const activated = method.activate();
    expect(activated.status).toBe("active");
  });

  it("throws when activating an already active method", () => {
    const method = MfaMethod.createActive(userId, "webauthn");
    expect(() => method.activate()).toThrow("Only pending methods can be activated.");
  });

  it("records usage for active method and updates lastUsedAt", () => {
    const created = new Date("2026-09-25T10:00:00Z");
    const method = MfaMethod.createActive(userId, "webauthn", created);

    const usedTime = new Date("2026-09-25T11:00:00Z");
    const usedMethod = method.recordUse(usedTime);

    expect(usedMethod.lastUsedAt).toEqual(usedTime);
  });

  it("throws when recording usage on non-active method", () => {
    const pending = MfaMethod.createPending(userId, "webauthn");
    expect(() => pending.recordUse()).toThrow("Only active methods can satisfy an MFA challenge.");

    const disabled = pending.disable();
    expect(() => disabled.recordUse()).toThrow("Only active methods can satisfy an MFA challenge.");
  });

  it("handles lockout policy on repeated failures", () => {
    let method = MfaMethod.createPending(userId, "webauthn");
    const now = new Date("2026-09-25T12:00:00Z");

    for (let i = 0; i < 5; i++) {
      method = method.recordFailedAttempt(now);
    }

    expect(method.failedAttempts).toBe(5);
    expect(method.isLockedAt(now)).toBe(true);

    const afterLock = new Date(now.getTime() + 10 * 60 * 1000);
    expect(method.isLockedAt(afterLock)).toBe(false);
  });

  it("reconstitutes persisted method", () => {
    const now = new Date();
    const reconstituted = MfaMethod.reconstitute({
      id: asId("method-1"),
      userId,
      type: "webauthn",
      status: "active",
      createdAt: now,
      failedAttempts: 2,
    });

    expect(reconstituted.id).toBe("method-1");
    expect(reconstituted.status).toBe("active");
    expect(reconstituted.failedAttempts).toBe(2);
  });
});
