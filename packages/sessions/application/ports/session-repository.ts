import type { Session, SessionId, UserId } from "../../domain/entities/session.js";

/**
 * The persistence contract the application layer needs for `Session` — the
 * **port** half of ports & adapters (hexagonal architecture). No Prisma, SQL,
 * Redis, or any other implementation detail appears here; the concrete adapter
 * (Phase 05, Postgres or Redis-backed) implements this interface without this
 * package ever depending on it. See `docs/guides/domain-modeling.md`.
 *
 * ## Method contracts
 *
 * ### save(session: Session): Promise<void>
 *
 * Persists a session, whether newly created or previously stored. This is an
 * idempotent upsert operation:
 *
 * - If no session with this id exists, a new row is created.
 * - If a session with this id already exists, it is updated with the new state.
 * - The caller does not distinguish "create" from "update" — the session
 *   instance's complete state (including expiry time, revocation status,
 *   last-seen timestamp) is the only contract. The adapter observes the state
 *   and persists it correctly regardless of whether the session is new or an
 *   update.
 *
 * Implementations should persist all session fields: id, userId, createdAt,
 * lastSeenAt, expiresAt, revokedAt (if set), and the expiryPolicy. The
 * expiryPolicy should be stored in a way that allows it to be reconstituted
 * (e.g., as a JSON object with { mode: "sliding" | "absolute", durationMs }).
 *
 * ### findById(sessionId: SessionId): Promise<Session | undefined>
 *
 * Retrieves a single session by its id, or returns `undefined` if no matching
 * session exists. A missing session is an expected, common outcome (e.g.,
 * checking whether a session id is valid), not an error condition.
 *
 * Returns `undefined` for:
 * - A session id that has never been saved.
 * - A session that existed but was deleted (if soft-delete is implemented).
 *
 * Note: Does NOT filter by expiry or revocation status. The repository returns
 * whatever row it finds; the caller is responsible for checking `isExpired()`
 * and `isRevoked()` to decide whether to accept it. This separation of concerns
 * lets callers apply time-dependent logic at the time of use (using their own
 * `now` reference, which matters for testing and time-zone independence).
 *
 * ### findActiveByUserId(userId: UserId): Promise<Session[]>
 *
 * Retrieves all sessions for a given user that are currently active. Returns
 * an array, which may be empty.
 *
 * "Active" means:
 * - The session has NOT been explicitly revoked (`isRevoked()` returns false).
 * - The session has NOT expired (`isExpired()` returns false when checked at
 *   the time of retrieval).
 *
 * Callers rely on this to list a user's valid login sessions (e.g., for a
 * session-management UI). The repository MUST apply these filters at retrieval
 * time, not leave it to the caller, because:
 * 1. Filtering in the storage layer is vastly cheaper (a WHERE clause) than
 *    fetching and filtering in the application layer.
 * 2. Implementations are free to optimize: a Redis-backed adapter might use
 *    TTL expiry to auto-delete, while a Postgres adapter uses a time check.
 *
 * The array is ordered by `lastSeenAt` descending (most-recently-active first)
 * to be useful for UIs listing a user's sessions. (This ordering is a
 * convenience; callers should not depend on it for correctness, only for UX.)
 *
 * ### revoke(sessionId: SessionId): Promise<void>
 *
 * Marks a single session as revoked, making it permanently unusable. A revoked
 * session will never become active again (even if not yet expired).
 *
 * This operation is idempotent: calling `revoke()` on an already-revoked
 * session is a no-op and does not fail. Revoking an expired session is also
 * idempotent and succeeds silently.
 *
 * If no session with the given id exists, this is also a silent no-op (the
 * session is "revoked" in the sense that there is no valid session with that
 * id, so the outcome is the same). This idempotency is important for
 * implementing reliable logout: a caller might retry a revoke request if unsure
 * whether the first one succeeded, and the second attempt must not cause an
 * error.
 *
 * ### revokeAllForUser(userId: UserId): Promise<void>
 *
 * Marks all of a given user's sessions as revoked, making them all permanently
 * unusable. This is the bulk operation used for "log out everywhere" / "revoke
 * all sessions" features.
 *
 * Behavior on edge cases:
 * - If a user has no sessions, this is a silent no-op.
 * - If a user's sessions are already revoked, this is a silent no-op (the
 *   operation is idempotent).
 * - If a user's sessions have already expired, this still revokes them
 *   (marking `revokedAt` so the record reflects an explicit revocation, not
 *   just natural expiry).
 *
 * Implementations must ensure atomicity: either all of a user's sessions are
 * revoked together, or none are. If the operation fails partway through, the
 * caller should receive an error and may retry the entire operation.
 *
 * The array returned by `findActiveByUserId()` for that user must be empty
 * after this call (because no session will be both non-revoked and non-expired,
 * unless new sessions are created between the revoke and the find).
 */
export interface SessionRepository {
  save(session: Session): Promise<void>;
  findById(sessionId: SessionId): Promise<Session | undefined>;
  findActiveByUserId(userId: UserId): Promise<Session[]>;
  revoke(sessionId: SessionId): Promise<void>;
  revokeAllForUser(userId: UserId): Promise<void>;
}
