/**
 * Configurable expiry policy for sessions.
 *
 * Two modes, each with distinct security/UX tradeoffs:
 * - **Sliding expiry:** extends `expiresAt` every time the session is touched
 *   (a request is made). Feels seamless (session never expires during active use),
 *   but can accumulate to arbitrarily long effective lifetimes under continuous
 *   activity. A background task that exercises a compromised session token
 *   indefinitely would prevent it from ever expiring.
 * - **Absolute expiry:** `expiresAt` is fixed when the session is created and
 *   never extended, regardless of activity. Guarantees that every session is
 *   bounded by a maximum absolute age. Trades UX (session expires mid-request
 *   if activity lapsed longer than the configured interval) for stronger
 *   worst-case security (even continuous reuse of a stolen token expires).
 *
 * Real production deployments typically combine both: absolute expiry on the
 * refresh token (e.g., 7 days) to bound long-term exposure, and sliding expiry
 * on the access token (e.g., 15 minutes sliding per access) to avoid constant
 * re-authentication. That design appears in Phase 05 (Issue 089).
 */
export type SessionExpiryMode = "sliding" | "absolute";

export class SessionExpiryPolicy {
  /**
   * @param mode - "sliding" to extend expiresAt on activity, "absolute" to ignore it
   * @param intervalMs - milliseconds the session should remain valid for
   */
  constructor(
    readonly mode: SessionExpiryMode,
    readonly intervalMs: number,
  ) {}

  /**
   * The timestamp when a freshly-created session with this policy would expire.
   * Input is the session's `createdAt`.
   */
  expiresAt(createdAt: Date): Date {
    return new Date(createdAt.getTime() + this.intervalMs);
  }

  /**
   * For a session with this policy, compute the new expiry if it's touched now.
   * - Sliding: extends to now + interval
   * - Absolute: returns the original expiresAt unchanged
   */
  maybeExtendExpiry(currentExpiresAt: Date, touchedNow: Date): Date {
    if (this.mode === "sliding") {
      return new Date(touchedNow.getTime() + this.intervalMs);
    }
    // Absolute mode ignores activity — return the original expiry unchanged
    return currentExpiresAt;
  }

  /**
   * Is the session expired at the given timestamp?
   */
  isExpired(expiresAt: Date, asOf: Date = new Date()): boolean {
    return asOf > expiresAt;
  }
}
