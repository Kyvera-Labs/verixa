import { NotFoundError, Result, ValidationError } from "@verixa/shared-kernel";

import type { User, UserId } from "../../domain/entities/user.js";
import type { UserRepository } from "../ports/user-repository.js";

export interface SuspendUserCommand {
  readonly userId: UserId;
  readonly reason: string;
}

export type SuspendUserError = ValidationError | NotFoundError;

/**
 * Admin-triggered moderation/security action. Unlike `User.suspend()`
 * itself (where a reason is optional), this use case *requires* one — an
 * admin suspending an account without recording why is exactly the kind of
 * unaccountable action the audit trail (Phase 10) exists to prevent.
 */
export class SuspendUser {
  constructor(private readonly userRepository: UserRepository) {}

  async execute(command: SuspendUserCommand): Promise<Result<User, SuspendUserError>> {
    const user = await this.userRepository.findById(command.userId);
    if (user === undefined) {
      return Result.err(new NotFoundError(`No user found with id "${command.userId}".`));
    }

    const reason = command.reason.trim();
    if (reason.length === 0) {
      return Result.err(
        new ValidationError("A reason is required to suspend a user.", { reason: ["required"] }),
      );
    }

    const result = user.suspend(reason);
    if (Result.isErr(result)) {
      return result;
    }

    await this.userRepository.save(result.value);
    return result;
  }
}
