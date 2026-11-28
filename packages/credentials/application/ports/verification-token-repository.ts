import type {
  EmailVerificationToken,
  EmailVerificationUserId,
} from "../../domain/entities/email-verification-token.js";
import type {
  PasswordResetToken,
  PasswordResetUserId,
} from "../../domain/entities/password-reset-token.js";

/**
 * Persistence for email verification tokens. Lookups use the token's hash, so the raw token never
 * reaches the database or its query logs. `invalidateOutstandingForUser` retires earlier tokens
 * when a new link is issued, so only the latest link works.
 */
export interface EmailVerificationTokenRepository {
  findByTokenHash(tokenHash: string): Promise<EmailVerificationToken | undefined>;
  save(token: EmailVerificationToken): Promise<void>;
  invalidateOutstandingForUser(userId: EmailVerificationUserId, now: Date): Promise<void>;
}

/**
 * Persistence for password reset tokens.
 *
 * Same shape and same reasoning as above, with the stakes raised: these
 * tokens are account takeover in a URL, so retiring the previous one on
 * reissue is not housekeeping but a security requirement.
 */
export interface PasswordResetTokenRepository {
  findByTokenHash(tokenHash: string): Promise<PasswordResetToken | undefined>;
  save(token: PasswordResetToken): Promise<void>;
  invalidateOutstandingForUser(userId: PasswordResetUserId, now: Date): Promise<void>;
}
