import { AccountLockedError, createId, Result } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import { MfaMethod } from "../../domain/entities/mfa-method.js";
import type { TotpAlgorithm } from "../../domain/services/totp-algorithm.js";
import type { MfaMethodRepository } from "../ports/mfa-method-repository.js";

import { VerifyTotpChallenge } from "./verify-totp-challenge.js";

describe("VerifyTotpChallenge", () => {
  const setup = () => {
    const savedMethods = new Map<string, MfaMethod>();

    const fakeRepo: MfaMethodRepository = {
      save: (method) => {
        savedMethods.set(method.id, method);
        return Promise.resolve();
      },
      findById: (id) => Promise.resolve(savedMethods.get(id)),
      findActiveByUserId: () => Promise.resolve([]),
      findPendingByUserId: () => Promise.resolve([]),
      findAllByUserId: () => Promise.resolve([]),
      delete: () => Promise.resolve(),
    };

    const fakeAlgo: TotpAlgorithm = {
      generateSecret: () => Promise.resolve({ value: "SECRET", provisioningUri: "uri" }),
      verify: (_secret, code) => {
        if (code === "VALID1") return Promise.resolve(1000);
        if (code === "VALID2") return Promise.resolve(1001); // Next step
        return Promise.resolve(null);
      },
    };

    const useCase = new VerifyTotpChallenge(fakeRepo, fakeAlgo);

    return { fakeRepo, fakeAlgo, useCase, savedMethods };
  };

  it("verifies a valid code and updates lastUsedAt and lastUsedStep", async () => {
    const { useCase, fakeRepo, savedMethods } = setup();
    const method = MfaMethod.createPendingTotp(createId<"UserId">(), {
      value: "SECRET",
    }).activate();
    await fakeRepo.save(method);

    const result = await useCase.execute({
      methodId: method.id,
      code: "VALID1",
    });

    expect(Result.isOk(result)).toBe(true);
    const updated = savedMethods.get(method.id)!;
    expect(updated.lastUsedStep).toBe(1000);
    expect(updated.lastUsedAt).toBeDefined();
    expect(updated.failedAttempts).toBe(0);
  });

  it("rejects code replay within the same or earlier step", async () => {
    const { useCase, fakeRepo, savedMethods } = setup();
    // Method already used at step 1000
    const method = MfaMethod.createPendingTotp(createId<"UserId">(), { value: "SECRET" })
      .activate()
      .recordTotpUse(1000, new Date());
    await fakeRepo.save(method);

    // Try to reuse a code that matches step 1000
    const result = await useCase.execute({
      methodId: method.id,
      code: "VALID1", // Maps to 1000
    });

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.message).toContain("already been used");
    }

    // It should also record a failed attempt for the replay
    const updated = savedMethods.get(method.id)!;
    expect(updated.failedAttempts).toBe(1);

    // But a newer step code should work
    const result2 = await useCase.execute({
      methodId: method.id,
      code: "VALID2", // Maps to 1001
    });

    expect(Result.isOk(result2)).toBe(true);
    const updated2 = savedMethods.get(method.id)!;
    expect(updated2.lastUsedStep).toBe(1001);
  });

  it("records a failure and enforces rate limits on invalid codes", async () => {
    const { useCase, fakeRepo } = setup();
    let method = MfaMethod.createPendingTotp(createId<"UserId">(), { value: "SECRET" }).activate();

    for (let i = 0; i < 5; i += 1) {
      method = method.recordFailedAttempt(new Date());
    }
    await fakeRepo.save(method);

    const result = await useCase.execute({
      methodId: method.id,
      code: "VALID1", // Even valid codes are rejected if locked
    });

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error).toBeInstanceOf(AccountLockedError);
    }
  });

  describe("Rate limiting (Issue 296 / #310)", () => {
    it("consults RateLimiter by account, throws RateLimitExceededError and records audit event on limit exceeded", async () => {
      const { fakeRepo, fakeAlgo } = setup();
      const userId = createId<"UserId">();
      const method = MfaMethod.createPendingTotp(userId, { value: "SECRET" }).activate();
      await fakeRepo.save(method);

      const auditCalls: Array<{ action: string; actorId: string }> = [];
      const auditLogger = {
        record: async (action: string, actorId: string) => {
          await Promise.resolve();
          auditCalls.push({ action, actorId });
        },
      };

      const rateLimiter = {
        check: async () => {
          await Promise.resolve();
          return {
            allowed: false,
            remaining: 0,
            resetAt: Date.now() + 60_000,
            limit: 5,
          };
        },
        recordFailure: async () => {
          await Promise.resolve();
        },
        reset: async () => {
          await Promise.resolve();
        },
      };

      const limitedUseCase = new VerifyTotpChallenge(fakeRepo, fakeAlgo, rateLimiter, auditLogger);

      await expect(
        limitedUseCase.execute({
          methodId: method.id,
          code: "VALID1",
        }),
      ).rejects.toThrow(`Rate limit exceeded for mfa on ${userId}`);

      expect(auditCalls).toHaveLength(1);
      expect(auditCalls[0]?.action).toBe("mfa.rate_limit_exceeded");
      expect(auditCalls[0]?.actorId).toBe(userId);
    });

    it("records failure on invalid code and resets on success", async () => {
      const { fakeRepo, fakeAlgo } = setup();
      const userId = createId<"UserId">();
      const method = MfaMethod.createPendingTotp(userId, { value: "SECRET" }).activate();
      await fakeRepo.save(method);

      const calls: string[] = [];
      const rateLimiter = {
        check: async () => {
          await Promise.resolve();
          calls.push("check");
          return { allowed: true, remaining: 4, resetAt: Date.now() + 60_000, limit: 5 };
        },
        recordFailure: async () => {
          await Promise.resolve();
          calls.push("recordFailure");
        },
        reset: async () => {
          await Promise.resolve();
          calls.push("reset");
        },
      };

      const limitedUseCase = new VerifyTotpChallenge(fakeRepo, fakeAlgo, rateLimiter);

      // Invalid code
      await limitedUseCase.execute({
        methodId: method.id,
        code: "WRONG1",
      });
      expect(calls).toEqual(["check", "recordFailure"]);

      // Valid code
      calls.length = 0;
      await limitedUseCase.execute({
        methodId: method.id,
        code: "VALID1",
      });
      expect(calls).toEqual(["check", "reset"]);
    });
  });
});
