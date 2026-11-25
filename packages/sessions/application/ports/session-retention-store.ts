/**
 * The storage operations session retention needs, kept narrow so the retention
 * target does not depend on how sessions are persisted.
 *
 * A session has *ended* once it was revoked or reached its absolute expiry,
 * whichever came first. A session that has not ended is live and is never
 * returned, however old it is.
 */
export interface SessionRetentionStore {
  /**
   * Sessions of the given users that ended at or before `endedBefore` and have
   * not already been `action`-ed. At most `limit`, oldest first.
   *
   * `anonymize` leaves the row in place, so an implementation must exclude
   * sessions it has already anonymized; otherwise they would be returned on
   * every run.
   */
  findEndedBefore(params: {
    userIds: readonly string[];
    endedBefore: Date;
    action: "delete" | "anonymize";
    limit: number;
  }): Promise<readonly { readonly id: string }[]>;

  /** The user who owns the session, or `undefined` when it does not exist. */
  ownerOf(sessionId: string): Promise<string | undefined>;

  /** Removes the session. `false` when it did not exist (already deleted). */
  deleteById(sessionId: string): Promise<boolean>;

  /**
   * Clears the network and device identifiers (IP address, user agent) while
   * keeping the row. `false` when it was already anonymized or did not exist.
   */
  anonymizeById(sessionId: string): Promise<boolean>;
}
