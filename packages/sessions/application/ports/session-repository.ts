import type { Session, SessionId, UserId } from "../../domain/entities/session.js";

/**
 * Port for session persistence — the interface every implementation (in-memory,
 * Prisma, Redis-backed, etc.) must satisfy.
 *
 * The contract is behavioral: two implementations must be observationally
 * identical from a caller's perspective. Contract testing (see
 * session-repository.contract.ts) verifies this by running the same test suite
 * against both the in-memory fake and, once it exists, the Prisma adapter.
 *
 * Implementations of this port are the only place where Prisma types or other
 * persistence-specific vocabulary appears. Domain and application layers
 * reference only this interface and the Session entity it trades in.
 */
export interface SessionRepository {
  /**
   * Persist a Session, creating it if it doesn't exist or updating it if it does.
   *
   * Idempotent: calling `save(session)` twice with the same session state
   * produces the same result as calling it once. This is what lets a use case
   * safely retry on transient failure without worrying about duplicates.
   *
   * @throws ConflictError if a unique constraint is violated (not expected for
   *   sessions, but possible if a future schema change adds constraints).
   */
  save(session: Session): Promise<void>;

  /**
   * Load a Session by ID, if one exists with that ID.
   *
   * Returns the session if found, regardless of its status (active or revoked).
   * Use-case-level logic decides whether to act on a revoked or expired session.
   *
   * Returns undefined if no session with that ID exists.
   */
  findById(sessionId: SessionId): Promise<Session | undefined>;

  /**
   * Load every active (non-revoked, non-expired) session for a given user.
   *
   * "Active" means:
   * - `status = 'active'` (not revoked)
   * - `expiresAt > now()` (not expired)
   *
   * Returns an empty array if the user has no active sessions.
   *
   * This is the query needed by:
   * - "List my devices" features (Issue 095)
   * - Concurrent-session-limit enforcement (Issue 094)
   * - "Log out everywhere" flows (Issue 092) as a precursor to revoke-all
   *
   * **Performance note:** Indexed on (userId, expiresAt) to support this query
   * without a table scan.
   */
  findActiveByUserId(userId: UserId): Promise<Session[]>;

  /**
   * Mark a single session as revoked (set status='revoked', record revokedAt).
   *
   * After this call, the session is no longer valid. A user presenting a token
   * from this session should be rejected.
   *
   * Idempotent: calling revoke multiple times on the same session is a no-op
   * after the first call.
   *
   * Does nothing (does not error) if no session with that ID exists — treating
   * "revoke a non-existent session" as a successful no-op is standard practice
   * for delete/revoke operations.
   */
  revoke(sessionId: SessionId): Promise<void>;

  /**
   * Revoke every session for a given user at once.
   *
   * Used by:
   * - "Log out on all devices" (Issue 092)
   * - Password-change flows (Phase 04, Issue 070)
   * - Admin account lockdown
   * - Suspected compromise responses
   *
   * After this call, every session for the user is invalid, and any tokens
   * issued from those sessions should be denied (via the deny-list in Issue 088,
   * once it exists).
   *
   * Idempotent and safe if called with a user who has no sessions.
   */
  revokeAllForUser(userId: UserId): Promise<void>;
}
