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
 * ## Why this one *does* say what went wrong
 *
 * Every other failure path in this package returns a single opaque error.
 * This one distinguishes "expired", "already used" and "not a token we
 * issued", and that is a considered difference rather than an inconsistency.
 *
 * Enumeration resistance protects a secret the attacker is *trying to
 * discover*: which addresses have accounts. Reaching this use case requires
 * already holding a 256-bit token, which is not guessable and which only
 * arrives by controlling the mailbox. There is nothing left to disclose — and
 * "this link expired" is genuinely useful, because the fix ("request another
 * one") is different from the fix for "already used" ("you are already
 * verified; just sign in").
 *
 * Copying the login rule here would produce a worse product for no security
 * gain, which is the failure mode of applying a good principle without its
 * reason.
 *
 * ## The rule that still applies
 *
 * An unknown token is reported identically to an expired one. That one *is* a
 * guess, so it gets nothing back.
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
      // "token" and assumes a secret comparison (Issue 208). This is a null
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
      // `activate`. Issue 068 asks for an event on success and the identity
      // model supplies it — this use case does not need its own, and adding a
      // second one would mean two records of one fact that can disagree.
      return Result.ok({ user: activated.value });
    });
  }
}
