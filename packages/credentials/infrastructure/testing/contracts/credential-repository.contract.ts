import { asId } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import type { CredentialRepository } from "../../../application/ports/credential-repository.js";
import { Credential } from "../../../domain/entities/credential.js";

function makeCredential(
  userIdStr: string,
  passwordHash = "$argon2id$v=19$m=65536,t=3,p=4$some-hash",
): Credential {
  return Credential.create({
    userId: asId<"UserId">(userIdStr),
    passwordHash,
  });
}

/**
 * Behavioral contract every `CredentialRepository` implementation must satisfy.
 * Run against `InMemoryCredentialRepository` and `PrismaCredentialRepository`.
 */
export function credentialRepositoryContract(createRepository: () => CredentialRepository): void {
  describe("CredentialRepository contract", () => {
    it("returns undefined for a user that has no saved credential", async () => {
      const repository = createRepository();
      const result = await repository.findByUserId(
        asId<"UserId">("00000000-0000-4000-8000-000000000099"),
      );
      expect(result).toBeUndefined();
    });

    it("saves and finds a credential by user id", async () => {
      const repository = createRepository();
      const cred = makeCredential("00000000-0000-4000-8000-000000000001");

      await repository.save(cred);

      const found = await repository.findByUserId(cred.userId);
      expect(found).toBeDefined();
      expect(found?.id).toBe(cred.id);
      expect(found?.userId).toBe(cred.userId);
      expect(found?.passwordHash).toBe(cred.passwordHash);
      expect(found?.failedAttempts).toBe(0);
      expect(found?.lockedUntil).toBeUndefined();
    });

    it("save is an idempotent upsert that updates existing credentials", async () => {
      const repository = createRepository();
      const cred = makeCredential("00000000-0000-4000-8000-000000000002");

      await repository.save(cred);

      const lockedDate = new Date(Date.now() + 60_000);
      const updated = Credential.reconstitute({
        id: cred.id,
        userId: cred.userId,
        passwordHash: "$argon2id$v=19$m=65536,t=3,p=4$updated-hash",
        failedAttempts: 3,
        lockedUntil: lockedDate,
        passwordHistory: [cred.passwordHash],
        createdAt: cred.createdAt,
        updatedAt: new Date(),
      });

      await repository.save(updated);

      const found = await repository.findByUserId(cred.userId);
      expect(found).toBeDefined();
      expect(found?.passwordHash).toBe("$argon2id$v=19$m=65536,t=3,p=4$updated-hash");
      expect(found?.failedAttempts).toBe(3);
      expect(found?.lockedUntil?.getTime()).toBe(lockedDate.getTime());
      expect(found?.passwordHistory).toContain(cred.passwordHash);
    });

    it("deletes a credential by user id", async () => {
      const repository = createRepository();
      const cred = makeCredential("00000000-0000-4000-8000-000000000003");

      await repository.save(cred);
      expect(await repository.findByUserId(cred.userId)).toBeDefined();

      await repository.deleteByUserId(cred.userId);
      expect(await repository.findByUserId(cred.userId)).toBeUndefined();
    });

    it("deleteByUserId is a no-op when credential does not exist", async () => {
      const repository = createRepository();
      await expect(
        repository.deleteByUserId(asId<"UserId">("00000000-0000-4000-8000-000000000098")),
      ).resolves.not.toThrow();
    });

    it("returns zero metrics when empty", async () => {
      const repository = createRepository();
      const metrics = await repository.getStaleCredentialMetrics({
        needsRehash: () => true,
      });

      expect(metrics).toEqual({
        count: 0,
        oldestCreatedAt: null,
        medianCreatedAt: null,
        p95CreatedAt: null,
      });
    });
  });
}
