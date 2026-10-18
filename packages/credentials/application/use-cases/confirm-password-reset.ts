import type { User } from "@verixa/identity";
import { type BruteForcePolicy, Result, ValidationError } from "@verixa/shared-kernel";

import { Credential } from "../../domain/entities/credential.js";
import { PasswordResetToken } from "../../domain/entities/password-reset-token.js";
import { type PasswordPolicy, RawPassword } from "../../domain/value-objects/raw-password.js";
import type { CredentialsUnitOfWork } from "../ports/credentials-unit-of-work.js";
import type { PasswordHasher } from "../ports/password-hasher.js";
import type { SessionRevoker } from "../ports/session-revoker.js";

export interface ConfirmPasswordResetCommand {
  readonly token: string;
  readonly newPassword: string;
}

export interface ConfirmPasswordResetResult {
  readonly user: User;
}

/**
 * Completes a password reset: validates the token, enforces the password
 * policy, replaces the credential, and revokes every existing session.
 *
 * ## The step everyone forgets
 *
 * **Revoking sessions is not cleanup.** It is the reason the flow exists.
 *
 * The scenario a reset is for is "someone else has my account". If they got
 * in, they are holding a session. Replacing the password revokes their
 * knowledge of the *credential* and does precisely nothing about the session
 * they already have — they stay signed in, indefinitely, while the user
 * believes they have just locked them out.
 *
 * The danger is not that the reset is insecure. It is that it is *believed to
 * have worked*. A user who knows they are still compromised takes further
 * action; one who thinks they are safe does not.
 *
 * Sessions are Phase 05, so `SessionRevoker` has no real implementation yet.
 * The call is here anyway, against a port, because the alternative is a
 * comment saying "remember to revoke sessions when Phase 05 lands" — and that
 * is the comment nobody reads.
 *
 * ## Ordering
 *
 * Token consumed → credential replaced → sessions revoked, all inside one
 * transaction except the revocation, which cannot be (it is an external
 * system). The consequence is stated rather than hidden: if revocation fails,
 * the password has still changed. That is the right way round — a user whose
 * password changed but whose old sessions survive is better off than one
 * whose reset silently did nothing — but it is a real partial failure, and
 * the error says so instead of reporting success.
 */
export class ConfirmPasswordReset {
  constructor(
    private readonly unitOfWork: CredentialsUnitOfWork,
    private readonly passwordHasher: PasswordHasher,
    private readonly sessionRevoker: SessionRevoker,
    private readonly passwordPolicy?: PasswordPolicy,
    /**
     * Optional, for the same reason as on `AuthenticateWithPassword`: the
     * existing callers stay valid, and a deployment without a shared store
     * still gets the single-use and expiry rules from the domain.
     */
    private readonly bruteForce?: BruteForcePolicy,
  ) {}

  async execute(
    command: ConfirmPasswordResetCommand,
  ): Promise<Result<ConfirmPasswordResetResult, ValidationError>> {
    // Policy first, before the token is looked up and before anything is
    // hashed. A rejected password should not consume the user's one-time
    // link — otherwise choosing a too-short password burns the reset and
    // sends them back to their inbox for another email.
    const passwordResult = RawPassword.create(command.newPassword, this.passwordPolicy);
    if (Result.isErr(passwordResult)) {
      return passwordResult;
    }

    const now = new Date();
    const tokenHash = PasswordResetToken.hashToken(command.token);

    // Keyed by the token's digest rather than the token: the digest is what the
    // lookup uses, it is safe to hold in memory or log, and repeated guesses
    // against one link share a budget.
    //
    // Guesses spread across freshly issued links do not share it. That case
    // belongs to the throttle on issuance and to the request-rate limiter
    // (Phase 15), not to this gate, and saying otherwise would overstate what
    // is wired here.
    if (this.bruteForce !== undefined) {
      const gate = await this.bruteForce.check("password-reset", tokenHash);
      if (!gate.allowed) {
        // The same refusal as a bad token, for the same reason: "too many
        // attempts" would confirm that a real link exists.
        return Result.err(
          new ValidationError("This reset link is not valid.", { token: ["invalid"] }),
        );
      }
    }

    // Hashed outside the transaction: it is the slowest thing here and needs
    // no database. Same reasoning as `RegisterUserWithPassword`.
    //
    // It does mean an invalid token still pays for a hash, which is a
    // deliberate trade in the other direction from usual — it costs a little
    // CPU on a bad request, and it keeps a valid token's transaction short.
    const newHash = await this.passwordHasher.hash(passwordResult.value.reveal());

    const outcome = await this.unitOfWork.run(async (repositories) => {
      const token = await repositories.passwordResetTokens.findByTokenHash(tokenHash);
      if (token === undefined || !token.matchesToken(command.token)) {
        return { kind: "invalid" as const };
      }

      const consumed = token.consume(now);
      if (Result.isErr(consumed)) {
        // The domain distinguishes expired from already-used. The caller does
        // not get that distinction here, unlike email verification, and the
        // difference is the stakes: an attacker holding a *used* reset token
        // learns from "already used" that it was real and that the account
        // exists. "Expired" leaks the same. One message for both.
        return { kind: "invalid" as const };
      }

      const user = await repositories.users.findById(token.userId);
      if (user === undefined) {
        return { kind: "invalid" as const };
      }

      await repositories.passwordResetTokens.save(consumed.value);

      // Upsert rather than requiring an existing row. The credential should
      // exist — `RequestPasswordReset` refuses to issue a token without one —
      // but a credential deleted between request and confirmation would
      // otherwise strand a valid token against a missing row.
      const existing = await repositories.credentials.findByUserId(user.id);
      const credential =
        existing === undefined
          ? Credential.create({ userId: user.id, passwordHash: newHash })
          : // `withPasswordHash` also clears the lockout, which matters
            // exactly here: the failures that locked the account were not the
            // owner's, and after a reset they have no way to wait one out.
            existing.withPasswordHash(newHash);

      await repositories.credentials.save(credential);

      return { kind: "ok" as const, user };
    });

    if (outcome.kind === "invalid") {
      // Every invalid outcome — unknown, expired, already used, or a token
      // whose user is gone — costs the same against this budget, which is the
      // point: they are indistinguishable to the caller and they are all
      // guesses.
      await this.bruteForce?.recordFailure("password-reset", tokenHash);
      return Result.err(
        new ValidationError("This reset link is not valid.", { token: ["invalid"] }),
      );
    }

    await this.bruteForce?.recordSuccess("password-reset", tokenHash);

    // Outside the transaction because it is an external system — a session
    // store, not this database. Inside, a slow or unavailable session service
    // would hold a database transaction open behind it.
    try {
      await this.sessionRevoker.revokeAllForUser(outcome.user.id);
    } catch {
      // Reported, not swallowed. Unlike a failed notification — where the
      // worst case is an email nobody received — a failed revocation means
      // the user believes they have locked an attacker out and they have not.
      // Silence here is the specific failure this use case exists to prevent.
      return Result.err(
        new ValidationError(
          "Your password was changed, but existing sessions could not be signed out. " +
            "Sign out of all devices manually.",
          { sessions: ["revocation_failed"] },
        ),
      );
    }

    return Result.ok({ user: outcome.user });
  }
}
