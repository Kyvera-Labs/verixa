import { createId, type Id, Result, ValidationError } from "@verixa/shared-kernel";

import { generateToken, hashToken, tokenMatchesDigest } from "../value-objects/token-digest.js";

export type PasswordResetTokenId = Id<"PasswordResetTokenId">;

/** A `UserId` from the identity context, referenced by value. See `Credential`. */
export type PasswordResetUserId = Id<"UserId">;

/**
 * Default lifetime: one hour, much shorter than email verification because a reset link can take
 * over the account.
 */
const DEFAULT_TTL_MS = 60 * 60 * 1000;

interface PasswordResetTokenProps {
  readonly id: PasswordResetTokenId;
  readonly userId: PasswordResetUserId;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly consumedAt: Date | undefined;
  readonly createdAt: Date;
}

/** A token plus the one-time raw value issued with it. */
export interface IssuedPasswordResetToken {
  readonly token: PasswordResetToken;
  /** The raw token, returned exactly once and never stored. */
  readonly rawToken: string;
}

/**
 * Authority to set a new password without knowing the old one: holding it is equivalent to holding
 * the account. Short-lived and single-use, so an old link cannot become a backdoor that survives
 * later password changes.
 */
export class PasswordResetToken {
  readonly id: PasswordResetTokenId;
  readonly userId: PasswordResetUserId;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly consumedAt: Date | undefined;
  readonly createdAt: Date;

  private constructor(props: PasswordResetTokenProps) {
    this.id = props.id;
    this.userId = props.userId;
    this.tokenHash = props.tokenHash;
    this.expiresAt = props.expiresAt;
    this.consumedAt = props.consumedAt;
    this.createdAt = props.createdAt;
  }

  /** SHA-256 of a raw token, hex-encoded. The only form ever persisted. */
  static hashToken(token: string): string {
    return hashToken(token);
  }

  static issue(params: {
    userId: PasswordResetUserId;
    ttlMs?: number;
    now?: Date;
  }): IssuedPasswordResetToken {
    const now = params.now ?? new Date();
    const rawToken = generateToken();

    return {
      rawToken,
      token: new PasswordResetToken({
        id: createId<"PasswordResetTokenId">(),
        userId: params.userId,
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(now.getTime() + (params.ttlMs ?? DEFAULT_TTL_MS)),
        consumedAt: undefined,
        createdAt: now,
      }),
    };
  }

  /** Rebuilds from already-trusted data (a database row). */
  static reconstitute(props: PasswordResetTokenProps): PasswordResetToken {
    return new PasswordResetToken(props);
  }

  /** Whether `candidate` is the raw token this was issued with, compared in constant time. */
  matchesToken(candidate: string): boolean {
    return tokenMatchesDigest(candidate, this.tokenHash);
  }

  isExpiredAt(now: Date): boolean {
    return now.getTime() >= this.expiresAt.getTime();
  }

  get isConsumed(): boolean {
    return this.consumedAt !== undefined;
  }

  /** Whether the token can still be redeemed. */
  isUsableAt(now: Date): boolean {
    return !this.isConsumed && !this.isExpiredAt(now);
  }

  /**
   * Retires the token without redeeming it, including an expired one, so every outstanding link
   * stops working when a replacement is issued. Idempotent; an already-consumed token keeps its
   * original redemption time.
   */
  invalidate(now: Date = new Date()): PasswordResetToken {
    if (this.isConsumed) {
      return this;
    }
    return new PasswordResetToken({ ...this, consumedAt: now });
  }

  /**
   * Marks the token used.
   *
   * Unlike email verification, the reason is **not** reported to the end
   * user by the use case above this. The domain still distinguishes the two
   * cases, because the audit log and operator need to; the HTTP layer
   * collapses them. See `ConfirmPasswordReset` for why.
   */
  consume(now: Date = new Date()): Result<PasswordResetToken, ValidationError> {
    if (this.isConsumed) {
      return Result.err(
        new ValidationError("This reset link has already been used.", { token: ["already_used"] }),
      );
    }

    if (this.isExpiredAt(now)) {
      return Result.err(
        new ValidationError("This reset link has expired.", { token: ["expired"] }),
      );
    }

    return Result.ok(new PasswordResetToken({ ...this, consumedAt: now }));
  }

  toJSON(): Record<string, unknown> {
    return {
      id: this.id,
      userId: this.userId,
      tokenHash: "[REDACTED]",
      expiresAt: this.expiresAt,
      consumedAt: this.consumedAt,
      createdAt: this.createdAt,
    };
  }

  [Symbol.for("nodejs.util.inspect.custom")](): Record<string, unknown> {
    return this.toJSON();
  }
}
