/**
 * Attempt counter a {@link BruteForcePolicy} reads and writes. A port so the policy does not depend
 * on Redis, Postgres or a test `Map`. Keyed by an opaque string the policy derives from scope and
 * identifier.
 */

/** What a store holds for one key. */
export interface AttemptRecord {
  /** Failed attempts counted in the current window. */
  readonly failedAttempts: number;
  /**
   * Until when this key is refused, or `null` when it is not locked. A store
   * that has never seen the key reads back as `{ failedAttempts: 0, lockedUntil: null }`.
   */
  readonly lockedUntil: Date | null;
}

export interface BruteForceAttemptStore {
  read(key: string): Promise<AttemptRecord>;

  /**
   * Increments the failure count and returns the record that results.
   *
   * `lockedUntil` is supplied by the caller rather than computed here: how long
   * a lockout lasts is the policy's decision, and the store only remembers it.
   */
  recordFailure(key: string, lockedUntil: Date | null): Promise<AttemptRecord>;

  /** Forgets the key entirely — a success, or a window that has expired. */
  clear(key: string): Promise<void>;
}
