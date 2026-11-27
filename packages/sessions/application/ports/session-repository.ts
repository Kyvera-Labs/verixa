import type { RefreshToken } from "../../domain/entities/refresh-token.js";
import type { Session, SessionId, SessionUserId } from "../../domain/entities/session.js";

/**
 * Persistence port for `Session` and its refresh-token rotation chain.
 *
 * - `findById` and `findRefreshTokenByHash` return `undefined` when nothing matches.
 * - `save` and `saveRefreshToken` are idempotent upserts.
 * - `findActiveByUserId` returns unrevoked sessions ordered by oldest `lastSeenAt` first; eviction
 *   relies on this order. It does not filter on expiry; use `Session.isActive`.
 * - `findRefreshTokenByHash` takes the token hash, never the raw token (see
 *   docs/security/token-storage.md).
 * - `revokeAllForUser` revokes all of a user's sessions in one call, so an adapter can use a single
 *   UPDATE.
 */
export interface SessionRepository {
  save(session: Session): Promise<void>;
  findById(id: SessionId): Promise<Session | undefined>;
  findActiveByUserId(userId: SessionUserId): Promise<readonly Session[]>;
  /** Revokes every one of `userId`'s sessions. Idempotent. */
  revokeAllForUser(userId: SessionUserId, now?: Date): Promise<void>;

  saveRefreshToken(refreshToken: RefreshToken): Promise<void>;
  findRefreshTokenByHash(tokenHash: string): Promise<RefreshToken | undefined>;
}
