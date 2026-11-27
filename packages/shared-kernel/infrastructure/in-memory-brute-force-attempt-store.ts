import type {
  AttemptRecord,
  BruteForceAttemptStore,
} from "../application/ports/brute-force-attempt-store.js";

/**
 * Map-backed attempt store: process-local and volatile, so a restart clears it and each replica has
 * its own. Single-threaded, so the policy's read-then-write cannot interleave; a durable adapter
 * must make that pair atomic. Expired keys are cleared on their next read; a spray of unique
 * identifiers can grow the map, which is why production should use a durable store.
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
