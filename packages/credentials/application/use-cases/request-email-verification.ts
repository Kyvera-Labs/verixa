import { Email } from "@verixa/identity";
import { Result, type ValidationError } from "@verixa/shared-kernel";

import { EmailVerificationToken } from "../../domain/entities/email-verification-token.js";
import type { CredentialNotifier } from "../ports/credential-notifier.js";
import type { CredentialsUnitOfWork } from "../ports/credentials-unit-of-work.js";

export interface RequestEmailVerificationCommand {
  readonly email: string;
}

export interface RequestEmailVerificationResult {
  /**
   * Whether a token was actually issued.
   *
   * **Must not reach the client.** It exists so tests and the audit log can
   * observe what happened, which is the only way to verify enumeration-safe
   * behaviour at all: the response is identical either way, so the assertion
   * has to look at something the response does not carry.
   */
  readonly issued: boolean;
}

/**
 * Sends, or silently declines to send, an email verification link. Always returns success, whatever
 * the account state, so the endpoint cannot be used to discover accounts. Tests observe {@link
 * RequestEmailVerificationResult.issued} instead (see docs/security/authentication-flows.md).
 */
export class RequestEmailVerification {
  constructor(
    private readonly unitOfWork: CredentialsUnitOfWork,
    private readonly notifier: CredentialNotifier,
    private readonly ttlMs?: number,
  ) {}

  async execute(
    command: RequestEmailVerificationCommand,
  ): Promise<Result<RequestEmailVerificationResult, ValidationError>> {
    const emailResult = Email.create(command.email);
    if (Result.isErr(emailResult)) {
      // Even a malformed address gets the generic success. A 400 here would
      // distinguish "that is not an email" from "that is an email we do not
      // know", which is a smaller leak than the account list but a leak
      // shaped the same way.
      return Result.ok({ issued: false });
    }

    const now = new Date();

    const delivery = await this.unitOfWork.run(async (repositories) => {
      const user = await repositories.users.findByEmail(emailResult.value);
      if (user === undefined) {
        return undefined;
      }

      // Already active: nothing to verify. Sending another link would be
      // both useless and a way to spam an address that did not ask, since
      // anyone can trigger this endpoint for any address.
      if (user.status !== "pending") {
        return undefined;
      }

      // Retires previous links before issuing a new one. Without this, a
      // user who clicks "resend" three times ends up with three working
      // links, two of them sitting in a mailbox nobody is watching.
      await repositories.emailVerificationTokens.invalidateOutstandingForUser(user.id, now);

      const issued = EmailVerificationToken.issue({
        userId: user.id,
        ...(this.ttlMs === undefined ? {} : { ttlMs: this.ttlMs }),
        now,
      });
      await repositories.emailVerificationTokens.save(issued.token);

      return { rawToken: issued.rawToken, expiresAt: issued.token.expiresAt };
    });

    if (delivery === undefined) {
      return Result.ok({ issued: false });
    }

    // Delivery happens after the transaction commits, and its failure does
    // not fail the request.
    //
    // Sending inside the transaction would be the classic dual-write bug: the
    // email goes out, the transaction then rolls back, and the user holds a
    // link for a token that does not exist. Committing first means the worst
    // case is a token nobody received — recoverable by asking again, which is
    // exactly what a user does when no email arrives.
    try {
      await this.notifier.sendEmailVerification({
        email: emailResult.value.value,
        rawToken: delivery.rawToken,
        expiresAt: delivery.expiresAt,
      });
    } catch {
      // Swallowed deliberately. Surfacing it would tell the caller that an
      // account exists (only a real account reaches this line), turning a
      // transient mail outage into the enumeration oracle this use case is
      // built to avoid.
    }

    return Result.ok({ issued: true });
  }
}
