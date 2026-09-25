import { createId, type DomainEvent, type Id } from "@verixa/shared-kernel";

import type { SessionExpiryPolicy } from "../value-objects/session-expiry-policy.js";

export type SessionId = Id<"SessionId">;
export type UserId = Id<"UserId">;

interface SessionProps {
  readonly id: SessionId;
  readonly userId: UserId;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt?: Date | undefined;
  readonly expiryPolicy: SessionExpiryPolicy;
  readonly domainEvents?: readonly DomainEvent[];
}

/**
 * A user session, tracking lifecycle and expiry independently of any token
 * format or storage mechanism.
 *
 * ## Responsibility scope
 *
 * This entity owns the session *identity* and lifecycle only: the fields
 * (timestamps, expiry) and the state machine (`isExpired`, `isRevoked`,
 * `touch`). It does NOT own:
 *
 * - Token format (JWT, opaque string, etc.) — that's a Phase 05 (Issues 084,
 *   086) detail to be decided later.
 * - Token storage (Redis, cookies, database rows) — Phase 05 (Issues 083,
 *   088) will layer on adapters.
 * - Token rotation or refresh — Issue 089 adds use-case logic for that.
 *
 * The entity encapsulates the policy driving expiry behavior via
 * {@link expiryPolicy}, which makes `touch()` genuinely pluggable without
 * hardcoding sliding or absolute expiry.
 *
 * ## Invariants
 *
 * - A session must have a positive lifetime: `expiresAt > createdAt`.
 * - `lastSeenAt` tracks activity but never exceeds `expiresAt`.
 * - Once `revokedAt` is set, it cannot be unset (revocation is terminal).
 * - `touch()` updates `lastSeenAt` and may extend `expiresAt` depending on
 *   the policy.
 */
export class Session {
  readonly id: SessionId;
  readonly userId: UserId;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | undefined;
  readonly expiryPolicy: SessionExpiryPolicy;
  private readonly domainEvents: readonly DomainEvent[];

  private constructor(props: SessionProps) {
    this.id = props.id;
    this.userId = props.userId;
    this.createdAt = props.createdAt;
    this.lastSeenAt = props.lastSeenAt;
    this.expiresAt = props.expiresAt;
    this.revokedAt = props.revokedAt;
    this.expiryPolicy = props.expiryPolicy;
    this.domainEvents = props.domainEvents ?? [];
  }

  /**
   * Creates a brand-new session for a user with the given expiry policy.
   *
   * Sets both `createdAt` and `lastSeenAt` to now; `expiresAt` is computed
   * from the policy's duration. The new session is not revoked.
   *
   * @param params.userId - The user this session belongs to.
   * @param params.expiryPolicy - The policy controlling how expiry behaves.
   * @returns The newly created session.
   */
  static create(params: { userId: UserId; expiryPolicy: SessionExpiryPolicy }): Session {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + params.expiryPolicy.durationMs);

    return new Session({
      id: createId<"SessionId">(),
      userId: params.userId,
      createdAt: now,
      lastSeenAt: now,
      expiresAt,
      expiryPolicy: params.expiryPolicy,
    });
  }

  /**
   * Rebuilds a session from already-trusted data (e.g. a database row).
   *
   * Unlike {@link create}, this does not validate invariants — the data is
   * assumed to already represent a previously-valid state.
   *
   * @param props - The session data to reconstitute.
   * @returns The reconstituted session.
   */
  static reconstitute(props: SessionProps): Session {
    return new Session({ ...props, domainEvents: [] });
  }

  /**
   * Whether this session has expired.
   *
   * A session is expired if `expiresAt` has passed, regardless of whether
   * it has been explicitly revoked. An expired session is unusable.
   *
   * @param asOf - The moment to check expiry against; defaults to now.
   * @returns `true` if the session has expired, `false` otherwise.
   */
  isExpired(asOf: Date = new Date()): boolean {
    return asOf >= this.expiresAt;
  }

  /**
   * Whether this session has been explicitly revoked.
   *
   * Revocation is terminal and independent of expiry — a revoked session is
   * always unusable, even if not yet expired by the clock. This is used to
   * implement logout and deny-list revocation (Issue 088).
   *
   * @returns `true` if the session is revoked, `false` otherwise.
   */
  isRevoked(): boolean {
    return this.revokedAt !== undefined;
  }

  /**
   * Marks the session as revoked at the given time.
   *
   * Once revoked, a session cannot be un-revoked. This method returns a new
   * session instance with `revokedAt` set (following the immutable entity
   * pattern from {@link User}).
   *
   * Calling `revoke()` on an already-revoked session is idempotent and
   * returns the same instance unchanged.
   *
   * @param revokedAt - When the session was revoked; defaults to now.
   * @returns A new session with revocation marked, or the same instance if
   *   already revoked.
   */
  revoke(revokedAt: Date = new Date()): Session {
    if (this.isRevoked()) {
      return this;
    }

    return new Session({
      ...this,
      revokedAt,
      domainEvents: [],
    });
  }

  /**
   * Updates the session's activity timestamp and (under a sliding policy)
   * extends the expiry time.
   *
   * Returns a new session instance with `lastSeenAt` updated to the current
   * time and, if using a sliding expiry policy, `expiresAt` pushed forward
   * by the policy's duration. If using an absolute policy, `expiresAt`
   * remains unchanged.
   *
   * This is a no-op on a revoked session — `touch()` returns the same
   * instance unchanged if the session is already revoked, since a revoked
   * session should not become active again.
   *
   * @param touchedAt - When the session was touched; defaults to now.
   * @returns A new session with activity recorded (and possibly expiry
   *   extended), or the same instance if revoked.
   */
  touch(touchedAt: Date = new Date()): Session {
    // Revoked sessions are immutable and not re-activated by touch.
    if (this.isRevoked()) {
      return this;
    }

    const newExpiresAt = this.expiryPolicy.computeNewExpiresAt(this.expiresAt, touchedAt);

    return new Session({
      ...this,
      lastSeenAt: touchedAt,
      expiresAt: newExpiresAt,
      domainEvents: [],
    });
  }

  /**
   * Returns domain events produced by the action that created this session
   * instance.
   *
   * For now, this returns an empty array (Phase 05, Issue 081 does not
   * define domain events yet), but the method is present to follow the
   * established entity pattern and to accommodate future event emission.
   */
  pullDomainEvents(): readonly DomainEvent[] {
    return this.domainEvents;
  }
}
