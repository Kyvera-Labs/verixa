import type { User, UserId } from "@verixa/identity";
import { Result, ValidationError } from "@verixa/shared-kernel";

import { type PasswordPolicy, RawPassword } from "../../domain/value-objects/raw-password.js";
import type { CredentialsUnitOfWork } from "../ports/credentials-unit-of-work.js";
import type { PasswordHasher } from "../ports/password-hasher.js";

export interface ChangePasswordCommand {
  readonly userId: UserId;
  readonly currentPassword: string;
  readonly newPassword: string;
}

export interface ChangePasswordResult {
  readonly user: User;
}

/**
 * Allows an authenticated user to change their own password by providing
 * their current password for re-authentication.
 *
 * Distinct from password reset (Issue 070):
 * - Requires the current password (step-up re-authentication)
 * - User must already be authenticated with a valid session
 * - Lower-friction than reset (no token/email flow)
 *
 * This previews Phase 06 MFA step-up authentication, where sensitive actions
 * require re-verification of identity.
 *
 * ## Security properties
 *
 * Wrong current password and new password policy violations both return a
 * generic {@link ValidationError}. Unlike login, enumeration is not a concern
 * here — the user is already authenticated and knows their own userId. The
 * user error (wrong password) can be stated clearly.
 *
 * **Lockout is cleared.** A user who successfully changes their password has
 * just demonstrated control of the account, so any lockout from failed login
 * attempts is cleared. They can immediately authenticate with the new password
 * and cannot be locked out of a credential they just set.
 *
 * **No session revocation.** Unlike password reset, which addresses "someone
 * else has my account", a password change by the owner does not necessitate
 * killing their own session. They stay logged in, which is the better UX.
 * Session invalidation is a Phase 15+ concern for coordinated security
 * responses.
 *
 * See `docs/security/authentication-flows.md`.
 */
export class ChangePassword {
  constructor(
    private readonly unitOfWork: CredentialsUnitOfWork,
    private readonly passwordHasher: PasswordHasher,
    private readonly passwordPolicy?: PasswordPolicy,
  ) {}

  async execute(
    command: ChangePasswordCommand,
  ): Promise<Result<ChangePasswordResult, ValidationError>> {
    // Validate new password first, before any database work. A rejected
    // password should not consume a hash operation.
    const passwordResult = RawPassword.create(command.newPassword, this.passwordPolicy);
    if (Result.isErr(passwordResult)) {
      return passwordResult;
    }

    // Hash outside the transaction: it is slow (~50-100ms) and needs no
    // database. Same reasoning as `RegisterUserWithPassword` and
    // `ConfirmPasswordReset`.
    const newHash = await this.passwordHasher.hash(passwordResult.value.reveal());

    const outcome = await this.unitOfWork.run(async (repositories) => {
      // Load the user to verify they still exist and to return them.
      const user = await repositories.users.findById(command.userId);
      if (user === undefined) {
        // User not found, but we do not distinguish this from wrong password
        // to prevent user enumeration — same reasoning as login (Issue 066).
        // In practice, this should not be reachable: an authenticated request
        // would not reach here with a userId that no longer exists.
        return { kind: "invalid" as const };
      }

      // Load the credential. An SSO-only or passkey-only account legitimately
      // has no password credential.
      const credential = await repositories.credentials.findByUserId(user.id);
      if (credential === undefined) {
        return { kind: "invalid" as const };
      }

      // Verify the current password. Wrong password or missing credential
      // are treated identically.
      const matches = await this.passwordHasher.verify(
        command.currentPassword,
        credential.passwordHash,
      );
      if (!matches) {
        return { kind: "invalid" as const };
      }

      // Update the credential with the new hash. `withPasswordHash` also
      // clears any lockout, which is correct: the user has just proved
      // control of their account and cannot be locked out of the credential
      // they just set.
      const updated = credential.withPasswordHash(newHash);
      await repositories.credentials.save(updated);

      return { kind: "ok" as const, user };
    });

    if (outcome.kind === "invalid") {
      return Result.err(
        new ValidationError("Current password is incorrect.", {
          currentPassword: ["invalid"],
        }),
      );
    }

    return Result.ok({ user: outcome.user });
  }
}
