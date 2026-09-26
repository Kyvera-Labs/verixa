import type { RevocationList } from "../../application/ports/revocation-list.js";
import type { SessionId } from "../../domain/value-objects/session-id.js";

/**
 * An in-memory {@link RevocationList} for unit-testing anything that revokes or
 * checks sessions, without a Redis. It honors TTLs against an injectable clock,
 * so expiry can be tested deterministically instead of by sleeping.
 *
 * It passes the same {@link import("./contracts/revocation-list.contract.js").revocationListContract | contract suite}
 * the Redis adapter does — the guarantee that "tested with the fake" means the
 * same thing as "tested with the real store," see `docs/guides/testing.md`.
 *
 * It does *not* model the Redis adapter's fail-closed behavior, because an
 * in-memory map has no unreachable state to fail from. That behavior is the one
 * thing genuinely specific to the Redis adapter and is tested there.
 */
export class InMemoryRevocationList implements RevocationList {
  /** sessionId → epoch-millis at which the entry expires. */
  private readonly entries = new Map<string, number>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  revoke(sessionId: SessionId, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) {
      return Promise.resolve();
    }
    this.entries.set(sessionId, this.now() + ttlSeconds * 1000);
    return Promise.resolve();
  }

  isRevoked(sessionId: SessionId): Promise<boolean> {
    const expiresAt = this.entries.get(sessionId);
    if (expiresAt === undefined) {
      return Promise.resolve(false);
    }
    if (expiresAt <= this.now()) {
      // Lazily evict, mirroring how Redis drops the key once its EX elapses.
      this.entries.delete(sessionId);
      return Promise.resolve(false);
    }
    return Promise.resolve(true);
  }
}
