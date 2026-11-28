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
 * Revokes nothing. Kept for deployments without the sessions package, where it is
 * genuinely a no-op — and it keeps the call site real rather than commented
 * out. The moment sessions exist, one line in the composition root replaces
 * this (see `SessionsPackageRevoker`).
 */
export class NoSessionsRevoker implements SessionRevoker {
  revokeAllForUser(): Promise<void> {
    return Promise.resolve();
  }
}
