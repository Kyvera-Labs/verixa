import type { Session, SessionId, UserId } from "../../domain/entities/session.js";
import type { SessionRepository } from "../../application/ports/session-repository.js";

/**
 * In-memory implementation of `SessionRepository`, suitable for unit tests.
 *
 * Stores sessions in a Map keyed by session ID. Used alongside the contract
 * test suite (session-repository.contract.ts) to verify that the port's
 * behavioral contract is unambiguous — if both the in-memory fake and a
 * real database adapter pass the same tests, they both behave the same way.
 */
export class InMemorySessionRepository implements SessionRepository {
  private sessions = new Map<SessionId, Session>();

  async save(session: Session): Promise<void> {
    this.sessions.set(session.id, session);
  }

  async findById(sessionId: SessionId): Promise<Session | undefined> {
    return this.sessions.get(sessionId);
  }

  async findActiveByUserId(userId: UserId): Promise<Session[]> {
    const now = new Date();
    return Array.from(this.sessions.values()).filter((session) => {
      // Active means: status is "active" AND not expired
      return session.status === "active" && !session.isExpired(now);
    });
  }

  async revoke(sessionId: SessionId): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session && !session.isRevoked()) {
      // Create a new revoked session and replace the old one
      this.sessions.set(sessionId, session.revoke());
    }
  }

  async revokeAllForUser(userId: UserId): Promise<void> {
    // Find all sessions for this user and revoke each one
    const sessionsToRevoke: SessionId[] = [];
    for (const [id, session] of this.sessions) {
      if (session.userId === userId && !session.isRevoked()) {
        sessionsToRevoke.push(id);
      }
    }

    for (const id of sessionsToRevoke) {
      await this.revoke(id);
    }
  }
}
