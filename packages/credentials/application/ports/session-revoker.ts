/**
 * Revokes every active session for a user. Called by password reset: a reset is usually done
 * because someone else has the account, and changing the password does nothing about the session
 * they already hold.
 */
export interface SessionRevoker {
  /** Revokes all sessions belonging to `userId`. Idempotent. */
  revokeAllForUser(userId: string): Promise<void>;
}

/**
 * A revoker with nothing to revoke.
 *
 * Correct until Phase 05 — there are no sessions, so revoking all of them is
 * genuinely a no-op — and it keeps the call site real rather than commented
 * out. The moment sessions exist, one line in the composition root replaces
 * this, and Issue 070 needs no change.
 */
export class NoSessionsRevoker implements SessionRevoker {
  revokeAllForUser(): Promise<void> {
    return Promise.resolve();
  }
}
