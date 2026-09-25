import { createId } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import type { SessionRepository } from "../../../application/ports/session-repository.js";
import { Session, type SessionId, type UserId } from "../../../domain/entities/session.js";
import { SessionExpiryPolicy } from "../../../domain/value-objects/session-expiry-policy.js";

/**
 * Behavioral contract every `SessionRepository` implementation must satisfy.
 * Run this against both `InMemorySessionRepository` and the
 * `PrismaSessionRepository` (once it exists) to ensure they behave identically.
 *
 * This is contract testing: one shared suite, multiple implementations, each
 * proven to behave identically rather than merely "compile against the same
 * interface."
 */
export function sessionRepositoryContract(
  createRepository: () => SessionRepository,
): void {
  describe("SessionRepository contract", () => {
    const userId = createId<"UserId">();
    const slidingPolicy = new SessionExpiryPolicy("sliding", 15 * 60 * 1000); // 15 minutes
    const absolutePolicy = new SessionExpiryPolicy("absolute", 24 * 60 * 60 * 1000); // 24 hours

    function makeSession(overrides?: { userId?: UserId; expiryPolicy?: InstanceType<typeof SessionExpiryPolicy> }): Session {
      return Session.create({
        id: createId<"SessionId">(),
        userId: overrides?.userId ?? userId,
        expiryPolicy: overrides?.expiryPolicy ?? slidingPolicy,
      });
    }

    it("returns undefined for a session that was never saved", async () => {
      const repository = createRepository();
      const sessionId = createId<"SessionId">();

      await expect(repository.findById(sessionId)).resolves.toBeUndefined();
    });

    it("finds a saved session by id", async () => {
      const repository = createRepository();
      const session = makeSession();

      await repository.save(session);
      const found = await repository.findById(session.id);

      expect(found).toBeDefined();
      expect(found?.id).toBe(session.id);
      expect(found?.userId).toBe(session.userId);
      expect(found?.status).toBe("active");
      expect(found?.isRevoked()).toBe(false);
    });

    it("save is idempotent — saving the same session twice produces no error", async () => {
      const repository = createRepository();
      const session = makeSession();

      await repository.save(session);
      // Save again — should not error or create a duplicate
      await repository.save(session);

      const found = await repository.findById(session.id);
      expect(found?.id).toBe(session.id);
    });

    it("returns only active sessions (status='active' and not expired) from findActiveByUserId", async () => {
      const repository = createRepository();
      const testUserId = createId<"UserId">();
      const now = new Date();

      // Create three sessions: one active, one revoked, one expired
      const activeSession = Session.create({
        id: createId<"SessionId">(),
        userId: testUserId,
        expiryPolicy: slidingPolicy,
        createdAt: now,
      });

      const revokedSession = Session.create({
        id: createId<"SessionId">(),
        userId: testUserId,
        expiryPolicy: slidingPolicy,
        createdAt: now,
      }).revoke(now);

      // Create an expired session by manually constructing one with a past expiry
      const expiredSession = Session.reconstitute({
        id: createId<"SessionId">(),
        userId: testUserId,
        createdAt: new Date(now.getTime() - 2 * 60 * 60 * 1000), // 2 hours ago
        lastSeenAt: new Date(now.getTime() - 1 * 60 * 60 * 1000), // 1 hour ago
        expiresAt: new Date(now.getTime() - 30 * 60 * 1000), // 30 minutes ago
        revokedAt: undefined,
        status: "active",
        expiryPolicy: slidingPolicy,
      });

      await repository.save(activeSession);
      await repository.save(revokedSession);
      await repository.save(expiredSession);

      const active = await repository.findActiveByUserId(testUserId);

      // Only the truly active session should be returned
      expect(active).toHaveLength(1);
      expect(active[0]?.id).toBe(activeSession.id);
    });

    it("returns empty array for a user with no sessions", async () => {
      const repository = createRepository();
      const testUserId = createId<"UserId">();

      const active = await repository.findActiveByUserId(testUserId);

      expect(active).toEqual([]);
    });

    it("revoke marks a session as revoked", async () => {
      const repository = createRepository();
      const session = makeSession();

      await repository.save(session);
      await repository.revoke(session.id);

      const found = await repository.findById(session.id);
      expect(found?.isRevoked()).toBe(true);
      expect(found?.revokedAt).toBeInstanceOf(Date);
    });

    it("revoke is idempotent — revoking an already-revoked session is a no-op", async () => {
      const repository = createRepository();
      const session = makeSession();

      await repository.save(session);
      await repository.revoke(session.id);
      const revokedOnce = await repository.findById(session.id);
      const revokedAtOnce = revokedOnce?.revokedAt;

      // Revoke again
      await repository.revoke(session.id);
      const revokedTwice = await repository.findById(session.id);

      // The revokedAt timestamp should not have changed
      expect(revokedTwice?.revokedAt?.getTime()).toBe(revokedAtOnce?.getTime());
    });

    it("revoke does not error if the session does not exist", async () => {
      const repository = createRepository();
      const nonExistentSessionId = createId<"SessionId">();

      // Should not throw
      await expect(repository.revoke(nonExistentSessionId)).resolves.not.toThrow();
    });

    it("revokeAllForUser revokes all sessions for a given user", async () => {
      const repository = createRepository();
      const testUserId = createId<"UserId">();

      // Create three sessions for the same user
      const session1 = Session.create({
        id: createId<"SessionId">(),
        userId: testUserId,
        expiryPolicy: slidingPolicy,
      });
      const session2 = Session.create({
        id: createId<"SessionId">(),
        userId: testUserId,
        expiryPolicy: slidingPolicy,
      });
      const session3 = Session.create({
        id: createId<"SessionId">(),
        userId: testUserId,
        expiryPolicy: slidingPolicy,
      });

      await repository.save(session1);
      await repository.save(session2);
      await repository.save(session3);

      // Revoke all for this user
      await repository.revokeAllForUser(testUserId);

      // All three should now be revoked
      const found1 = await repository.findById(session1.id);
      const found2 = await repository.findById(session2.id);
      const found3 = await repository.findById(session3.id);

      expect(found1?.isRevoked()).toBe(true);
      expect(found2?.isRevoked()).toBe(true);
      expect(found3?.isRevoked()).toBe(true);
    });

    it("revokeAllForUser only revokes sessions for the specified user", async () => {
      const repository = createRepository();
      const userId1 = createId<"UserId">();
      const userId2 = createId<"UserId">();

      // Create a session for userId1
      const session1 = Session.create({
        id: createId<"SessionId">(),
        userId: userId1,
        expiryPolicy: slidingPolicy,
      });

      // Create a session for userId2
      const session2 = Session.create({
        id: createId<"SessionId">(),
        userId: userId2,
        expiryPolicy: slidingPolicy,
      });

      await repository.save(session1);
      await repository.save(session2);

      // Revoke all for userId1
      await repository.revokeAllForUser(userId1);

      // session1 should be revoked, session2 should still be active
      const found1 = await repository.findById(session1.id);
      const found2 = await repository.findById(session2.id);

      expect(found1?.isRevoked()).toBe(true);
      expect(found2?.isRevoked()).toBe(false);
    });

    it("revokeAllForUser does not error if the user has no sessions", async () => {
      const repository = createRepository();
      const testUserId = createId<"UserId">();

      // Should not throw
      await expect(repository.revokeAllForUser(testUserId)).resolves.not.toThrow();
    });

    it("touch on a session updates lastSeenAt and may extend expiresAt", async () => {
      const repository = createRepository();
      const session = makeSession({ expiryPolicy: slidingPolicy });
      const originalExpiresAt = session.expiresAt;

      await repository.save(session);

      // Touch the session after 5 minutes
      const touchedAt = new Date(session.createdAt.getTime() + 5 * 60 * 1000);
      const touched = session.touch(touchedAt);

      await repository.save(touched);
      const found = await repository.findById(session.id);

      // lastSeenAt should be updated
      expect(found?.lastSeenAt.getTime()).toBe(touchedAt.getTime());

      // For sliding policy, expiresAt should be extended
      expect(found?.expiresAt.getTime()).toBeGreaterThan(originalExpiresAt.getTime());
    });

    it("session with absolute expiry does not extend on touch", async () => {
      const repository = createRepository();
      const session = makeSession({ expiryPolicy: absolutePolicy });
      const originalExpiresAt = session.expiresAt;

      await repository.save(session);

      // Touch the session
      const touchedAt = new Date(session.createdAt.getTime() + 5 * 60 * 1000);
      const touched = session.touch(touchedAt);

      await repository.save(touched);
      const found = await repository.findById(session.id);

      // expiresAt should NOT have changed
      expect(found?.expiresAt.getTime()).toBe(originalExpiresAt.getTime());
    });
  });
}
