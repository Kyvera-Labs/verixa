import type {
  AttemptRecord,
  BruteForceAttemptStore,
} from "../application/ports/brute-force-attempt-store.js";

/**
 * A `Map` behind the attempt-store port.
 *
 * Process-local and volatile, which is a real limitation and stated as one: a
 * restart clears every counter, and each API replica keeps its own. What it
 * buys is that the policy is usable and tested today, with no Redis and no
 * schema, against the same interface Phase 15 will point at a durable store.
 * Swapping it is a composition-root change, not a policy change.
 *
 * Single-threaded by construction, so the policy's read-then-write is not
 * interleaved with itself. A durable adapter has to make that pair atomic;
 * this one gets it from the event loop.
 *
 * Entries expire on their own terms rather than by eviction: a key past its
 * lockout is cleared the next time the policy reads it, and a key that never
 * comes back costs one map entry. Unbounded growth is possible in principle
 * from a spray of unique identifiers, which is the same trade every in-memory
 * limiter makes and the reason a real deployment uses the durable adapter.
 */
export class InMemoryBruteForceAttemptStore implements BruteForceAttemptStore {
  private readonly records = new Map<string, AttemptRecord>();

  read(key: string): Promise<AttemptRecord> {
    return Promise.resolve(this.records.get(key) ?? { failedAttempts: 0, lockedUntil: null });
  }

  recordFailure(key: string, lockedUntil: Date | null): Promise<AttemptRecord> {
    const current = this.records.get(key);
    const next: AttemptRecord = {
      failedAttempts: (current?.failedAttempts ?? 0) + 1,
      lockedUntil,
    };
    this.records.set(key, next);
    return Promise.resolve(next);
  }

  clear(key: string): Promise<void> {
    this.records.delete(key);
    return Promise.resolve();
  }
}
