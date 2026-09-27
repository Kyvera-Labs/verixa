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
import { createId, Result } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import { MfaMethodType } from "../value-objects/mfa-method-type.js";
import { MfaMethod } from "./mfa-method.js";

describe("MfaMethod", () => {
  const userId = createId<"UserId">();
  const typeResult = MfaMethodType.create("totp");
  if (!Result.isOk(typeResult)) {
    throw new Error("Failed to create MfaMethodType for testing");
  }
  const type = typeResult.value;

  describe("enroll", () => {
    it("starts a method in pending state", () => {
      const method = MfaMethod.enroll({ userId, type });
      expect(method.userId).toBe(userId);
      expect(method.type.value).toBe("totp");
      expect(method.status).toBe("pending");
      expect(method.createdAt).toBeInstanceOf(Date);
      expect(method.lastUsedAt).toBeUndefined();
    });
  });

  describe("activate", () => {
    it("transitions a pending method to active", () => {
      const method = MfaMethod.enroll({ userId, type });
      const result = method.activate();
      expect(Result.isOk(result) && result.value.status).toBe("active");
    });

    it("transitions a disabled method to active", () => {
      const method = MfaMethod.enroll({ userId, type });
      const active = method.activate();
      const disabled = Result.isOk(active) ? active.value.disable() : active;
      const reactivated = Result.isOk(disabled) ? disabled.value.activate() : disabled;
      expect(Result.isOk(reactivated) && reactivated.value.status).toBe("active");
    });

    it("fails if already active", () => {
      const method = MfaMethod.enroll({ userId, type });
      const active = method.activate();
      const result = Result.isOk(active) ? active.value.activate() : active;
      expect(Result.isErr(result)).toBe(true);
      if (Result.isErr(result)) {
        expect(result.error).toBeDefined();
      }
    });
  });

  describe("disable", () => {
    it("transitions an active method to disabled", () => {
      const method = MfaMethod.enroll({ userId, type });
      const active = method.activate();
      const result = Result.isOk(active) ? active.value.disable() : active;
      expect(Result.isOk(result) && result.value.status).toBe("disabled");
    });

    it("transitions a pending method to disabled", () => {
      const method = MfaMethod.enroll({ userId, type });
      const result = method.disable();
      expect(Result.isOk(result) && result.value.status).toBe("disabled");
    });

    it("fails if already disabled", () => {
      const method = MfaMethod.enroll({ userId, type });
      const disabled = method.disable();
      const result = Result.isOk(disabled) ? disabled.value.disable() : disabled;
      expect(Result.isErr(result)).toBe(true);
      if (Result.isErr(result)) {
        expect(result.error).toBeDefined();
      }
    });
  });

  describe("recordUse", () => {
    it("updates lastUsedAt for an active method", () => {
      const method = MfaMethod.enroll({ userId, type });
      const active = method.activate();
      const before = new Date();
      const result = Result.isOk(active) ? active.value.recordUse() : active;

      expect(Result.isOk(result)).toBe(true);
      if (Result.isOk(result)) {
        expect(result.value.lastUsedAt).toBeDefined();
        expect(result.value.lastUsedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
      }
    });

    it("enforces that pending methods cannot satisfy a challenge", () => {
      const method = MfaMethod.enroll({ userId, type });
      const result = method.recordUse();

      expect(Result.isErr(result)).toBe(true);
      if (Result.isErr(result)) {
        expect(result.error).toBeDefined();
      }
    });

    it("enforces that disabled methods cannot satisfy a challenge", () => {
      const method = MfaMethod.enroll({ userId, type });
      const disabled = method.disable();
      const result = Result.isOk(disabled) ? disabled.value.recordUse() : disabled;

      expect(Result.isErr(result)).toBe(true);
      if (Result.isErr(result)) {
        expect(result.error).toBeDefined();
      }
    });
  });
});
