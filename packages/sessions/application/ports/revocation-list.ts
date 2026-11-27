import type { SessionId } from "../../domain/entities/session.js";

/**
 * Deny-list of revoked sessions, checked on every request with an access token. Access tokens are
 * stateless JWTs that stay valid until they expire, so revocation (logout, logout everywhere,
 * refresh-token reuse, eviction) records the session ID here with a TTL no longer than the token
 * lifetime (see docs/security/threat-model-sessions.md).
 *
 * Keyed by `sessionId`, which every access token carries, so one entry revokes all of a session's
 * tokens. Redis-backed in production because it is on the hot path and expiring keys need no
 * cleanup job.
 */
export interface RevocationList {
  /** Marks `sessionId` revoked until `until` (normally the access token's own expiry). */
  revoke(sessionId: SessionId, until: Date): Promise<void>;
  /** Whether `sessionId` is currently revoked. */
  isRevoked(sessionId: SessionId): Promise<boolean>;
}
