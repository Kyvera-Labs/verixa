import { asId } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import type {
  EmailVerificationTokenRepository,
  PasswordResetTokenRepository,
} from "../../../application/ports/verification-token-repository.js";
import { EmailVerificationToken } from "../../../domain/entities/email-verification-token.js";
import { PasswordResetToken } from "../../../domain/entities/password-reset-token.js";

/**
 * Behavioral contract every `EmailVerificationTokenRepository` implementation must satisfy.
 */
export function emailVerificationTokenRepositoryContract(
  createRepository: () => EmailVerificationTokenRepository,
): void {
  describe("EmailVerificationTokenRepository contract", () => {
    it("returns undefined for an unknown token hash", async () => {
      const repository = createRepository();
      const result = await repository.findByTokenHash(
        "0000000000000000000000000000000000000000000000000000000000000000",
      );
      expect(result).toBeUndefined();
    });

    it("saves and retrieves an email verification token by hash", async () => {
      const repository = createRepository();
      const { token } = EmailVerificationToken.issue({
        userId: asId<"UserId">("00000000-0000-4000-8000-000000000010"),
      });

      await repository.save(token);

      const found = await repository.findByTokenHash(token.tokenHash);
      expect(found).toBeDefined();
      expect(found?.id).toBe(token.id);
      expect(found?.userId).toBe(token.userId);
      expect(found?.tokenHash).toBe(token.tokenHash);
      expect(found?.consumedAt).toBeUndefined();
    });

    it("save is an idempotent upsert that records consumption", async () => {
      const repository = createRepository();
      const { token } = EmailVerificationToken.issue({
        userId: asId<"UserId">("00000000-0000-4000-8000-000000000011"),
      });

      await repository.save(token);

      const consumed = token.consume(new Date());
      if (consumed.kind === "err") throw consumed.error;
      await repository.save(consumed.value);

      const found = await repository.findByTokenHash(token.tokenHash);
      expect(found).toBeDefined();
      expect(found?.consumedAt).toBeDefined();
    });

    it("invalidates all outstanding tokens for a user", async () => {
      const repository = createRepository();
      const userId = asId<"UserId">("00000000-0000-4000-8000-000000000012");
      const otherUserId = asId<"UserId">("00000000-0000-4000-8000-000000000013");

      const { token: token1 } = EmailVerificationToken.issue({ userId });
      const { token: token2 } = EmailVerificationToken.issue({ userId });
      const { token: otherToken } = EmailVerificationToken.issue({ userId: otherUserId });

      await repository.save(token1);
      await repository.save(token2);
      await repository.save(otherToken);

      const now = new Date();
      await repository.invalidateOutstandingForUser(userId, now);

      const found1 = await repository.findByTokenHash(token1.tokenHash);
      const found2 = await repository.findByTokenHash(token2.tokenHash);
      const foundOther = await repository.findByTokenHash(otherToken.tokenHash);

      expect(found1?.consumedAt).toBeDefined();
      expect(found2?.consumedAt).toBeDefined();
      expect(foundOther?.consumedAt).toBeUndefined();
    });
  });
}

/**
 * Behavioral contract every `PasswordResetTokenRepository` implementation must satisfy.
 */
export function passwordResetTokenRepositoryContract(
  createRepository: () => PasswordResetTokenRepository,
): void {
  describe("PasswordResetTokenRepository contract", () => {
    it("returns undefined for an unknown token hash", async () => {
      const repository = createRepository();
      const result = await repository.findByTokenHash(
        "0000000000000000000000000000000000000000000000000000000000000000",
      );
      expect(result).toBeUndefined();
    });

    it("saves and retrieves a password reset token by hash", async () => {
      const repository = createRepository();
      const { token } = PasswordResetToken.issue({
        userId: asId<"UserId">("00000000-0000-4000-8000-000000000020"),
      });

      await repository.save(token);

      const found = await repository.findByTokenHash(token.tokenHash);
      expect(found).toBeDefined();
      expect(found?.id).toBe(token.id);
      expect(found?.userId).toBe(token.userId);
      expect(found?.tokenHash).toBe(token.tokenHash);
      expect(found?.consumedAt).toBeUndefined();
    });

    it("save is an idempotent upsert that records consumption", async () => {
      const repository = createRepository();
      const { token } = PasswordResetToken.issue({
        userId: asId<"UserId">("00000000-0000-4000-8000-000000000021"),
      });

      await repository.save(token);

      const consumed = token.consume(new Date());
      if (consumed.kind === "err") throw consumed.error;
      await repository.save(consumed.value);

      const found = await repository.findByTokenHash(token.tokenHash);
      expect(found).toBeDefined();
      expect(found?.consumedAt).toBeDefined();
    });

    it("invalidates all outstanding reset tokens for a user", async () => {
      const repository = createRepository();
      const userId = asId<"UserId">("00000000-0000-4000-8000-000000000022");
      const otherUserId = asId<"UserId">("00000000-0000-4000-8000-000000000023");

      const { token: token1 } = PasswordResetToken.issue({ userId });
      const { token: token2 } = PasswordResetToken.issue({ userId });
      const { token: otherToken } = PasswordResetToken.issue({ userId: otherUserId });

      await repository.save(token1);
      await repository.save(token2);
      await repository.save(otherToken);

      const now = new Date();
      await repository.invalidateOutstandingForUser(userId, now);

      const found1 = await repository.findByTokenHash(token1.tokenHash);
      const found2 = await repository.findByTokenHash(token2.tokenHash);
      const foundOther = await repository.findByTokenHash(otherToken.tokenHash);

      expect(found1?.consumedAt).toBeDefined();
      expect(found2?.consumedAt).toBeDefined();
      expect(foundOther?.consumedAt).toBeUndefined();
    });
  });
}
