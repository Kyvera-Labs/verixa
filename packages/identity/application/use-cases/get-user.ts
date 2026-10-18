import { Result } from "@verixa/shared-kernel";

import type { User, UserId } from "../../domain/entities/user.js";
import type { UserRepository } from "../ports/user-repository.js";

export interface GetUserCommand {
  readonly id: UserId;
}

/**
 * Retrieves a single `User` by `UserId`.
 *
 * Excludes soft-deleted users (delegating to `userRepository.findById`).
 * A missing user is returned as `Result.ok(undefined)` rather than an error,
 * matching the repository contract where non-existence is an expected query outcome.
 */
export class GetUser {
  constructor(private readonly userRepository: UserRepository) {}

  async execute(command: GetUserCommand): Promise<Result<User | undefined, never>> {
    const user = await this.userRepository.findById(command.id);
    return Result.ok(user);
  }
}
