import type { Redis } from "ioredis";

import type { RevocationList } from "../application/ports/revocation-list.js";
import type { SessionId } from "../domain/entities/session.js";

export interface RedisRevocationListOptions {
  /**
   * Namespace prepended to every session id before it becomes a Redis key.
   * Keeps the deny-list from colliding with anything else sharing the same
   * Redis, and makes `SCAN revoked:session:*` a meaningful operational query.
   */
  readonly keyPrefix?: string;
}

const DEFAULT_KEY_PREFIX = "sessions:revoked:";

/**
 * Redis-backed {@link RevocationList}: one key per revoked session with a `PX` expiry, so entries
 * disappear once the access tokens they block would have expired. A `PX` already in the past
 * expires the key immediately instead of erroring.
 *
 * {@link isRevoked} fails closed: if Redis is unreachable, tokens are treated as revoked. An auth
 * outage is loud and recoverable; silently re-admitting a revoked, possibly stolen session is not
 * (see docs/security/token-design.md).
 *
 * {@link revoke} lets errors propagate, so a logout or reset never reports success for a revocation
 * that did not persist.
 */
export class RedisRevocationList implements RevocationList {
  private readonly keyPrefix: string;

  constructor(
    private readonly client: Redis,
    options: RedisRevocationListOptions = {},
  ) {
    this.keyPrefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
  }

  async revoke(sessionId: SessionId, until: Date): Promise<void> {
    const ttlMs = Math.max(1, until.getTime() - Date.now());
    await this.client.set(this.keyFor(sessionId), "1", "PX", ttlMs);
  }

  async isRevoked(sessionId: SessionId): Promise<boolean> {
    try {
      const value = await this.client.get(this.keyFor(sessionId));
      return value !== null;
    } catch {
      // Fail closed. See the class comment: a session we cannot confirm is
      // safe is treated as revoked, not waved through.
      return true;
    }
  }

  private keyFor(sessionId: SessionId): string {
    return `${this.keyPrefix}${sessionId}`;
  }
}
