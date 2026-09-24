import { type Id, Result } from "@verixa/shared-kernel";

import { SessionExpiryPolicy } from "../value-objects/session-expiry-policy.js";

export type SessionId = Id<"SessionId">;
export type UserId = Id<"UserId">;

/**
 * Lifecycle state of a session.
 * - **active:** The session is valid and can be used.
 * - **revoked:** The session has been explicitly revoked and is no longer valid.
 */
export type SessionStatus = "active" | "revoked";

/**
 * The Session aggregate root. Represents an authenticated user's session,
 * tracking its lifecycle from creation through expiry or explicit revocation.
 *
 * Sessions are immutable: methods return either a new instance (via Result, if
 * a transition can fail) or the same instance unchanged (for idempotent
 * operations like revoke). This mirrors the pattern used by User and
 * Organization aggregates.
 *
 * A session can end in two ways:
 * 1. **Expiry:** `expiresAt` passes; `isExpired()` returns true
 * 2. **Revocation:** `revoke()` is called; `revokedAt` is set and `status` becomes "revoked"
 */
export class Session {
  private constructor(
    readonly id: SessionId,
    readonly userId: UserId,
    readonly createdAt: Date,
    readonly lastSeenAt: Date,
    readonly expiresAt: Date,
    readonly revokedAt: Date | undefined,
    readonly status: SessionStatus,
    readonly expiryPolicy: SessionExpiryPolicy,
  ) {}

  /**
   * Create a new Session aggregate.
   *
   * Called by domain logic or use cases when a session is first created
   * (e.g., after a successful login). The returned Session carries the
   * initial expiryPolicy but has not yet been persisted.
   */
  static create(input: {
    id: SessionId;
    userId: UserId;
    expiryPolicy: SessionExpiryPolicy;
    createdAt?: Date;
  }): Session {
    const now = input.createdAt ?? new Date();
    return new Session(
      input.id,
      input.userId,
      now,
      now, // lastSeenAt starts at creation
      input.expiryPolicy.expiresAt(now),
      undefined, // not revoked
      "active",
      input.expiryPolicy,
    );
  }

  /**
   * Rebuild a Session from persisted data (e.g., a database row).
   *
   * Used by the persistence layer to reconstitute an aggregate after loading
   * it. Does not re-run creation validation: the data is assumed to be
   * already-valid (it was valid when saved, so re-running checks would be
   * redundant).
   */
  static reconstitute(input: {
    id: SessionId;
    userId: UserId;
    createdAt: Date;
    lastSeenAt: Date;
    expiresAt: Date;
    revokedAt: Date | undefined;
    status: SessionStatus;
    expiryPolicy: SessionExpiryPolicy;
  }): Session {
    return new Session(
      input.id,
      input.userId,
      input.createdAt,
      input.lastSeenAt,
      input.expiresAt,
      input.revokedAt,
      input.status,
      input.expiryPolicy,
    );
  }

  /**
   * Is this session no longer valid?
   *
   * True if either expired or revoked. Once either is true, the session
   * cannot be "un-expired" or "un-revoked" — a new session must be issued.
   */
  isInvalid(asOf: Date = new Date()): boolean {
    return this.isExpired(asOf) || this.isRevoked();
  }

  /**
   * Is the session's `expiresAt` timestamp in the past?
   *
   * Note: a revoked session may or may not be expired yet. This method only
   * checks the expiry clock, not the revocation status.
   */
  isExpired(asOf: Date = new Date()): boolean {
    return this.expiryPolicy.isExpired(this.expiresAt, asOf);
  }

  /**
   * Has this session been explicitly revoked?
   */
  isRevoked(): boolean {
    return this.status === "revoked";
  }

  /**
   * Record activity on this session, optionally extending the expiry.
   *
   * Under a sliding-expiry policy, this extends `expiresAt` to now + interval.
   * Under absolute expiry, this returns the same session unchanged.
   * In either case, `lastSeenAt` is updated to the current time.
   *
   * Returns a new Session with updated timestamps (or the same instance if
   * no change was needed, though callers should not rely on reference equality).
   */
  touch(touchedAt: Date = new Date()): Session {
    const newExpiresAt = this.expiryPolicy.maybeExtendExpiry(this.expiresAt, touchedAt);

    // If expiry changed, return a new instance; otherwise return this unchanged
    if (newExpiresAt.getTime() === this.expiresAt.getTime() && touchedAt === this.lastSeenAt) {
      return this;
    }

    return new Session(
      this.id,
      this.userId,
      this.createdAt,
      touchedAt,
      newExpiresAt,
      this.revokedAt,
      this.status,
      this.expiryPolicy,
    );
  }

  /**
   * Revoke this session, making it invalid immediately.
   *
   * Returns a new Session with status="revoked" and revokedAt set to the
   * current time.
   */
  revoke(revokedAt: Date = new Date()): Session {
    return new Session(
      this.id,
      this.userId,
      this.createdAt,
      this.lastSeenAt,
      this.expiresAt,
      revokedAt,
      "revoked",
      this.expiryPolicy,
    );
  }
}
