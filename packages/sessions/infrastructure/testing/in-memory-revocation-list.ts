import type { RevocationList } from "../../application/ports/revocation-list.js";
import type { SessionId } from "../../domain/entities/session.js";

/**
 * In-memory {@link RevocationList} for tests without Redis. Checks `until` against an injectable
 * clock and lazily evicts expired entries, mirroring Redis key expiry.
 */
export class InMemoryRevocationList implements RevocationList {
  private readonly revokedUntilBySessionId = new Map<SessionId, Date>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  revoke(sessionId: SessionId, until: Date): Promise<void> {
    this.revokedUntilBySessionId.set(sessionId, until);
    return Promise.resolve();
  }

  isRevoked(sessionId: SessionId): Promise<boolean> {
    const until = this.revokedUntilBySessionId.get(sessionId);
    if (until === undefined) {
      return Promise.resolve(false);
    }
    if (until.getTime() <= this.now()) {
      this.revokedUntilBySessionId.delete(sessionId);
      return Promise.resolve(false);
    }
    return Promise.resolve(true);
  }
}
