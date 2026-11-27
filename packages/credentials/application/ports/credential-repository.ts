import type { Credential, CredentialUserId } from "../../domain/entities/credential.js";

/**
 * Metrics on credentials hashed below current cost parameters. They can only be upgraded at login,
 * so dormant accounts can stay weak for years (see
 * docs/security/password-storage.md#dormant-accounts-the-password-upgrade-gap).
 */
export interface StaleCredentialMetrics {
  /** Total count of credentials below current cost parameters. */
  readonly count: number;
  /** ISO 8601 timestamp of the oldest stale credential. */
  readonly oldestCreatedAt: Date | null;
  /** ISO 8601 timestamp of the median (50th percentile) creation time. */
  readonly medianCreatedAt: Date | null;
  /** ISO 8601 timestamp of the 95th percentile creation time. */
  readonly p95CreatedAt: Date | null;
}

/**
 * Persistence port for `Credential`.
 *
 * - `findByUserId` returns `undefined` when the user has no credential, which is normal for
 *   SSO-only and passkey-only accounts.
 * - `save` is an idempotent upsert.
 * - `deleteByUserId` removes password authentication without deleting the user.
 * - `getStaleCredentialMetrics` reports credentials below current cost parameters.
 */
export interface CredentialRepository {
  findByUserId(userId: CredentialUserId): Promise<Credential | undefined>;
  save(credential: Credential): Promise<void>;
  deleteByUserId(userId: CredentialUserId): Promise<void>;
  /**
   * Metrics on credentials below current cost parameters.
   *
   * Called with the current hasher so it can determine which hashes are stale.
   * Returns count, oldest, median, and 95th-percentile creation dates.
   */
  getStaleCredentialMetrics(currentHasher: {
    needsRehash(encodedHash: string): boolean;
  }): Promise<StaleCredentialMetrics>;
}
