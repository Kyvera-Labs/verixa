/**
 * The attempt counter a {@link BruteForcePolicy} reads and writes (Issue 209).
 *
 * A port, not an implementation: the shared kernel must not know whether
 * counters live in Redis, Postgres, or a `Map` in a test. Phase 15 supplies the
 * durable one; the in-memory adapter beside this file is what makes the policy
 * usable and testable today.
 *
 * Keyed by an opaque `key` string the policy derives (scope + identifier), so
 * nothing here knows what an account is, and no adapter has to agree on how a
 * tenant or an identifier is spelled.
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
