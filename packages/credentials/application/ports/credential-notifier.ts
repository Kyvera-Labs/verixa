/**
 * Delivers the one-time links produced by email verification and password reset.
 *
 * This is the only place a raw token leaves the use case, so it is the one place to check that
 * tokens are never logged, returned or persisted. Implementations must not log the token.
 */
export interface CredentialNotifier {
  /**
   * Sends an email verification link.
   *
   * Implementations should treat failure as retryable and must not throw in a
   * way that fails the calling use case — the token has already been issued
   * and stored, and a delivery failure is recoverable by requesting another.
   */
  sendEmailVerification(params: {
    readonly email: string;
    readonly rawToken: string;
    readonly expiresAt: Date;
  }): Promise<void>;

  /** Sends a password reset link. */
  sendPasswordReset(params: {
    readonly email: string;
    readonly rawToken: string;
    readonly expiresAt: Date;
  }): Promise<void>;
}

/**
 * Notifier that delivers nothing. Deliberately silent instead of logging "would have sent" with the
 * token, which would leak reset tokens to log storage; without a mail adapter the flow visibly does
 * not work.
 */
export class NullCredentialNotifier implements CredentialNotifier {
  sendEmailVerification(): Promise<void> {
    return Promise.resolve();
  }

  sendPasswordReset(): Promise<void> {
    return Promise.resolve();
  }
}
