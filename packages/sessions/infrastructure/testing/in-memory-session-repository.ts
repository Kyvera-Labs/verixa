import type { Session, SessionId, UserId } from "../../domain/entities/session.js";
import type { SessionRepository } from "../../application/ports/session-repository.js";

/**
 * In-memory implementation of SessionRepository, backed by a Map.
 *
 * Suitable for unit and integration tests of session use cases before real
 * persistence exists. Correctly implements the "active" semantics, revoke
 * idempotency, and all other contract details documented in the port — the
 * behavior must match the port's prose exactly, since the whole point is that
 * this fake and a future real adapter must behave identically from the
 * caller's perspective.
 *
 * Not thread-safe; this is a test fake, not production code.
 */
export class InMemorySessionRepository implements SessionRepository {
  private readonly sessions = new Map<string, Session>();

  async save(session: Session): Promise<void> {
    // Idempotent upsert: store the session state as-is, overwriting any
    // previous version.
    this.sessions.set(session.id, session);
  }

  async findById(sessionId: SessionId): Promise<Session | undefined> {
    return this.sessions.get(sessionId);
  }

  async findActiveByUserId(userId: UserId): Promise<Session[]> {
    const now = new Date();
    const active = Array.from(this.sessions.values())
      .filter(
        (session) =>
          session.userId === userId &&
          !session.isRevoked() &&
          !session.isExpired(now),
      )
      // Sort by lastSeenAt descending (most recently active first)
      .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());

    return active;
  }

  async revoke(sessionId: SessionId): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      // Revoke is idempotent: calling revoke() on an already-revoked session
      // returns the same instance unchanged (per Session.revoke() semantics).
      const revoked = session.revoke();
      this.sessions.set(sessionId, revoked);
    }
    // If the session doesn't exist, this is a silent no-op (idempotent).
  }

  async revokeAllForUser(userId: UserId): Promise<void> {
    // Iterate over all sessions for this user and revoke each one.
    const sessionsToRevoke = Array.from(this.sessions.entries()).filter(
      ([, session]) => session.userId === userId,
    );

    for (const [sessionId, session] of sessionsToRevoke) {
      // Revoke is idempotent, so re-revoking an already-revoked session is safe.
      const revoked = session.revoke();
      this.sessions.set(sessionId, revoked);
    }
  }
}
