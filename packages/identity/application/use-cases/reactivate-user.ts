import { NotFoundError, Result, ValidationError } from "@verixa/shared-kernel";

import type { User, UserId } from "../../domain/entities/user.js";
import type { UserRepository } from "../ports/user-repository.js";

export interface ReactivateUserCommand {
  readonly userId: UserId;
  readonly reason: string;
}

export type ReactivateUserError = ValidationError | NotFoundError;

/**
 * Admin-triggered lifting of a suspension. Deliberately narrower than
 * `User.activate()`, which also legally allows `pending` → `active` (e.g.
 * email verification) — this use case only makes sense for a user who was
 * actually suspended, so it rejects `pending`/`deleted` users itself rather
 * than relying on the domain's generic transition rule, which would
 * otherwise silently "reactivate" a pending user that was never suspended.
 */
export class ReactivateUser {
  constructor(private readonly userRepository: UserRepository) {}

  async execute(command: ReactivateUserCommand): Promise<Result<User, ReactivateUserError>> {
    const user = await this.userRepository.findById(command.userId);
    if (user === undefined) {
      return Result.err(new NotFoundError(`No user found with id "${command.userId}".`));
    }

    if (user.status !== "suspended") {
      return Result.err(
        new ValidationError(
          `Cannot reactivate a user in "${user.status}" status; only suspended users can be reactivated.`,
          { status: ["not_suspended"] },
        ),
      );
    }

    const reason = command.reason.trim();
    if (reason.length === 0) {
      return Result.err(
        new ValidationError("A reason is required to reactivate a user.", { reason: ["required"] }),
      );
    }

    const result = user.activate(reason);
    if (Result.isErr(result)) {
      return result;
    }

    await this.userRepository.save(result.value);
    return result;
  }
}
