import { buildContainer, type Container } from "@verixa/api/composition-root";
import { EmailVerificationToken, PasswordResetToken } from "@verixa/credentials";
import { Result } from "@verixa/shared-kernel";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createTestPrismaClient, databaseAvailability } from "./helpers/database.js";

/**
 * Email verification and password reset against a real Postgres, covering what in-memory tests
 * cannot: filters, nullable `timestamptz` round trips and the `token_hash` unique index. Uses the
 * real container so wiring is tested too.
 */

const available = await databaseAvailability();

describe.skipIf(!available)("verification and reset tokens against Postgres", () => {
  const prisma = createTestPrismaClient();
  let container: Container;

  beforeAll(() => {
    container = buildContainer(prisma);
  }, 60_000);

  afterEach(async () => {
    await prisma.emailVerificationToken.deleteMany({});
    await prisma.passwordResetToken.deleteMany({});
    await prisma.credential.deleteMany({});
    await prisma.invitation.deleteMany({});
    await prisma.organizationMembership.deleteMany({});
    await prisma.organization.deleteMany({});
    await prisma.user.deleteMany({});
  });

  afterAll(async () => {
    await prisma.$disconnect();
  }, 60_000);

  const EMAIL = "alice@example.com";
  const PASSWORD = "correct horse battery staple";

  async function registerAlice(): Promise<string> {
    const result = await container.credentials.registerUserWithPassword.execute({
      email: EMAIL,
      displayName: "Alice",
      password: PASSWORD,
    });
    if (!Result.isOk(result)) throw new Error("fixture setup failed");
    return result.value.user.id;
  }

  describe("email verification", () => {
    it("persists only the digest", async () => {
      await registerAlice();

      const result = await container.credentials.requestEmailVerification.execute({ email: EMAIL });

      expect(Result.isOk(result) && result.value.issued).toBe(true);
      const rows = await prisma.emailVerificationToken.findMany();
      expect(rows).toHaveLength(1);
      // 64 hex characters of SHA-256, and nothing resembling the base64url
      // token that was issued.
      expect(rows[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0]?.consumedAt).toBeNull();
    });

    it("round-trips an unconsumed token through the nullable column", async () => {
      // `undefined` in the domain, `null` in the column. The mapper converts
      // both ways, and getting it wrong in one direction produces a token
      // that reads back as permanently consumed — or never consumable.
      const userId = await registerAlice();
      await container.credentials.requestEmailVerification.execute({ email: EMAIL });

      const row = await prisma.emailVerificationToken.findFirst();
      const token = EmailVerificationToken.reconstitute({
        id: row?.id as never,
        userId: userId as never,
        tokenHash: row?.tokenHash ?? "",
        expiresAt: row?.expiresAt ?? new Date(),
        consumedAt: row?.consumedAt ?? undefined,
        createdAt: row?.createdAt ?? new Date(),
      });

      expect(token.isConsumed).toBe(false);
    });

    it("retires outstanding tokens with a single statement", async () => {
      // `invalidateOutstandingForUser` is an `updateMany`. If its `where`
      // clause were wrong it would either retire nothing (leaving several
      // live links) or retire everything for every user.
      await registerAlice();

      await container.credentials.requestEmailVerification.execute({ email: EMAIL });
      await container.credentials.requestEmailVerification.execute({ email: EMAIL });
      await container.credentials.requestEmailVerification.execute({ email: EMAIL });

      const rows = await prisma.emailVerificationToken.findMany({ orderBy: { createdAt: "asc" } });
      expect(rows).toHaveLength(3);
      expect(rows.filter((row) => row.consumedAt === null)).toHaveLength(1);
    });

    it("does not retire another user's tokens", async () => {
      await registerAlice();
      await container.credentials.registerUserWithPassword.execute({
        email: "bob@example.com",
        displayName: "Bob",
        password: PASSWORD,
      });

      await container.credentials.requestEmailVerification.execute({ email: "bob@example.com" });
      await container.credentials.requestEmailVerification.execute({ email: EMAIL });
      await container.credentials.requestEmailVerification.execute({ email: EMAIL });

      const bob = await prisma.user.findFirst({ where: { email: "bob@example.com" } });
      const bobTokens = await prisma.emailVerificationToken.findMany({
        where: { userId: bob?.id ?? "" },
      });
      expect(bobTokens).toHaveLength(1);
      expect(bobTokens[0]?.consumedAt).toBeNull();
    });

    it("cascades on user deletion", async () => {
      // A verification token for a deleted user is unusable by definition,
      // and keeping it would retain a link between an address and an account
      // that no longer exists — the data erasure is meant to remove.
      const userId = await registerAlice();
      await container.credentials.requestEmailVerification.execute({ email: EMAIL });

      await prisma.user.delete({ where: { id: userId } });

      await expect(prisma.emailVerificationToken.count()).resolves.toBe(0);
    });

    it("rejects a duplicate digest at the database level", async () => {
      const userId = await registerAlice();
      const now = new Date();
      const row = {
        userId,
        tokenHash: "a".repeat(64),
        expiresAt: new Date(now.getTime() + 60_000),
        createdAt: now,
      };
      await prisma.emailVerificationToken.create({ data: { id: crypto.randomUUID(), ...row } });

      // Unique rather than merely indexed: a collision, or a replayed insert,
      // must be a constraint violation rather than two rows that both redeem.
      await expect(
        prisma.emailVerificationToken.create({ data: { id: crypto.randomUUID(), ...row } }),
      ).rejects.toThrow();
    });
  });

  describe("password reset", () => {
    it("completes a reset end to end and lets the new password authenticate", async () => {
      await registerAlice();

      // The notifier is the null one, so the raw token never leaves the use
      // case. Reading it back is impossible by design — which is the point of
      // the design, and means this test has to issue its own token to have
      // something to redeem.
      const user = await prisma.user.findFirstOrThrow({ where: { email: EMAIL } });
      const issued = PasswordResetToken.issue({ userId: user.id as never });
      await prisma.passwordResetToken.create({
        data: {
          id: issued.token.id,
          userId: user.id,
          tokenHash: issued.token.tokenHash,
          expiresAt: issued.token.expiresAt,
          createdAt: issued.token.createdAt,
        },
      });

      const confirmed = await container.credentials.confirmPasswordReset.execute({
        token: issued.rawToken,
        newPassword: "an entirely different passphrase",
      });
      expect(Result.isOk(confirmed)).toBe(true);

      const withNew = await container.credentials.authenticateWithPassword.execute({
        email: EMAIL,
        password: "an entirely different passphrase",
      });
      expect(Result.isOk(withNew)).toBe(true);

      const withOld = await container.credentials.authenticateWithPassword.execute({
        email: EMAIL,
        password: PASSWORD,
      });
      expect(Result.isErr(withOld)).toBe(true);
    });

    it("marks the token consumed in the database", async () => {
      await registerAlice();
      const user = await prisma.user.findFirstOrThrow({ where: { email: EMAIL } });
      const issued = PasswordResetToken.issue({ userId: user.id as never });
      await prisma.passwordResetToken.create({
        data: {
          id: issued.token.id,
          userId: user.id,
          tokenHash: issued.token.tokenHash,
          expiresAt: issued.token.expiresAt,
          createdAt: issued.token.createdAt,
        },
      });

      await container.credentials.confirmPasswordReset.execute({
        token: issued.rawToken,
        newPassword: "an entirely different passphrase",
      });

      const row = await prisma.passwordResetToken.findFirst();
      expect(row?.consumedAt).not.toBeNull();

      // And it cannot be redeemed twice — the property that stops an old
      // link in a mailbox being a permanent backdoor.
      const replay = await container.credentials.confirmPasswordReset.execute({
        token: issued.rawToken,
        newPassword: "yet another passphrase entirely",
      });
      expect(Result.isErr(replay)).toBe(true);
    });

    it("issues nothing for an unknown address, and says nothing either way", async () => {
      await registerAlice();

      const known = await container.credentials.requestPasswordReset.execute({ email: EMAIL });
      const unknown = await container.credentials.requestPasswordReset.execute({
        email: "nobody@example.com",
      });

      expect(Result.isOk(known)).toBe(true);
      expect(Result.isOk(unknown)).toBe(true);
      // Exactly one row: the difference is real, and visible only here.
      await expect(prisma.passwordResetToken.count()).resolves.toBe(1);
    });
  });
});
