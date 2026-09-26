import { describe, expect, it } from "vitest";
import type { MfaMethodRepository } from "../../../application/ports/mfa-method-repository.js";
import { MfaMethod, type UserId, type MfaMethodId } from "../../../domain/entities/mfa-method.js";

export function mfaMethodRepositoryContract(
  createRepository: () => MfaMethodRepository,
  setupUser: () => Promise<UserId>
): void {
  describe("MfaMethodRepository contract", () => {
    it("returns undefined for a missing method", async () => {
      const repo = createRepository();
      const dummyId = "00000000-0000-0000-0000-000000000000" as MfaMethodId;
      await expect(repo.findById(dummyId)).resolves.toBeUndefined();
    });

    it("saves and finds a method by id", async () => {
      const repo = createRepository();
      const userId = await setupUser();
      const method = MfaMethod.create(userId, "totp", "super-secret");
      await repo.save(method);

      const found = await repo.findById(method.id);
      expect(found).toBeDefined();
      expect(found?.id).toBe(method.id);
      expect(found?.secret).toBe("super-secret");
      expect(found?.userId).toBe(userId);
      expect(found?.type).toBe("totp");
    });

    it("finds active methods by userId", async () => {
      const repo = createRepository();
      const userId = await setupUser();
      const method = MfaMethod.create(userId, "totp", "secret1");
      method.activate();
      await repo.save(method);

      const active = await repo.findActiveByUserId(userId);
      expect(active).toHaveLength(1);
      expect(active[0]?.id).toBe(method.id);
      
      const pending = await repo.findPendingByUserId(userId);
      expect(pending).toHaveLength(0);
    });

    it("deletes a method", async () => {
      const repo = createRepository();
      const userId = await setupUser();
      const method = MfaMethod.create(userId, "webauthn");
      await repo.save(method);
      await repo.delete(method.id);
      await expect(repo.findById(method.id)).resolves.toBeUndefined();
    });
  });
}
