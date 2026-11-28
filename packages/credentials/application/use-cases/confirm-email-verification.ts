import type { User } from "@verixa/identity";
import { Result, ValidationError } from "@verixa/shared-kernel";

import { EmailVerificationToken } from "../../domain/entities/email-verification-token.js";
import type { CredentialsUnitOfWork } from "../ports/credentials-unit-of-work.js";

export interface ConfirmEmailVerificationCommand {
  readonly token: string;
}

export interface ConfirmEmailVerificationResult {
  readonly user: User;
}

/**
 * Redeems a verification link, moving the user from `pending` to `active`.
 *
 * Unlike login, this reports "expired" and "already used" separately: the caller already holds an
 * unguessable token from the mailbox, so nothing is disclosed, and the fixes differ. An unknown
 * token is reported the same as an expired one, since that may be a guess.
 */
export class ConfirmEmailVerification {
  constructor(private readonly unitOfWork: CredentialsUnitOfWork) {}

  async execute(
    command: ConfirmEmailVerificationCommand,
  ): Promise<Result<ConfirmEmailVerificationResult, ValidationError>> {
    const now = new Date();

    // Looked up by digest, never by raw token. A query log, a slow-query
    // trace, or an APM span capturing parameters then records a value nobody
    // can replay.
    const tokenHash = EmailVerificationToken.hashToken(command.token);

    return this.unitOfWork.run(async (repositories) => {
      const token = await repositories.emailVerificationTokens.findByTokenHash(tokenHash);
      // `security/detect-possible-timing-attacks` matches the operand name
      // "token" and assumes a secret comparison. This is a null
      // check on a lookup result, and its timing reveals only whether the row
      // exists — which the response already reveals. The actual secret
      // comparison, `matchesToken`, is constant-time below.
      // eslint-disable-next-line security/detect-possible-timing-attacks
      if (token === undefined) {
        return Result.err(
          new ValidationError("This verification link is not valid.", { token: ["invalid"] }),
        );
      }

      // Belt and braces: the lookup already matched on digest, so this can
      // only fail on a hash collision. Constant-time, because comparing
      // secrets with `===` is a habit worth not having exceptions to.
      if (!token.matchesToken(command.token)) {
        return Result.err(
          new ValidationError("This verification link is not valid.", { token: ["invalid"] }),
        );
      }

      const consumed = token.consume(now);
      if (Result.isErr(consumed)) {
        return consumed;
      }

      const user = await repositories.users.findById(token.userId);
      if (user === undefined) {
        // The token's user was deleted between issuance and redemption. The
        // FK cascades, so this is close to unreachable — but "close to" is
        // not "never", and the alternative is an unhandled undefined.
        return Result.err(
          new ValidationError("This verification link is not valid.", { token: ["invalid"] }),
        );
      }

      // Consumed *before* the activation is attempted, and saved either way,
      // so a token cannot be retried against a user whose status refuses the
      // transition. Otherwise a suspended user's link would stay live until
      // it expired, waiting for the suspension to lift.
      await repositories.emailVerificationTokens.save(consumed.value);

      const activated = user.activate("email verified");
      if (Result.isErr(activated)) {
        // `pending → active` is legal; `suspended → active` is too, which is
        // deliberate in the identity model. What lands here is a `deleted`
        // user, whose transitions are all refused.
        return Result.err(
          new ValidationError("This account cannot be activated.", { token: ["invalid"] }),
        );
      }

      await repositories.users.save(activated.value);

      // The `UserStatusChanged` event is already on the aggregate, emitted by
      // `activate`. An event is required on success and the identity
      // model supplies it — this use case does not need its own, and adding a
      // second one would mean two records of one fact that can disagree.
      return Result.ok({ user: activated.value });
    });
  }
}
