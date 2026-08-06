import {
  NotFoundError,
  Result,
  ValidationError,
  ValidationErrorAggregator,
} from "@verixa/shared-kernel";

import type { User, UserId } from "../../domain/entities/user.js";
import { DisplayName } from "../../domain/value-objects/display-name.js";
import { PersonName } from "../../domain/value-objects/person-name.js";
import type { UserRepository } from "../ports/user-repository.js";

export interface UpdateUserProfileCommand {
  readonly userId: UserId;
  readonly displayName?: string;
  readonly givenName?: string;
  readonly familyName?: string;
}

export type UpdateUserProfileError = ValidationError | NotFoundError;

/**
 * Updates a user's display name and/or person name. Only the fields present
 * on the command are validated and changed — a `Partial<T>`-shaped update
 * where "not provided" (`undefined`) and "explicitly clearing" are two
 * different things (see `docs/guides/use-cases.md` for why `familyName`
 * being provided-but-empty still goes through `PersonName.create`, which
 * treats an empty string as "no family name," rather than the use case
 * trying to special-case it).
 */
export class UpdateUserProfile {
  constructor(private readonly userRepository: UserRepository) {}

  async execute(command: UpdateUserProfileCommand): Promise<Result<User, UpdateUserProfileError>> {
    const user = await this.userRepository.findById(command.userId);
    if (user === undefined) {
      return Result.err(new NotFoundError(`No user found with id "${command.userId}".`));
    }

    const errors = new ValidationErrorAggregator();
    let nextDisplayName = user.displayName;
    let nextPersonName = user.personName;

    if (command.displayName !== undefined) {
      const validated = errors.collect(DisplayName.create(command.displayName));
      if (validated !== undefined) {
        nextDisplayName = validated;
      }
    }

    if (command.givenName !== undefined) {
      const validated = errors.collect(PersonName.create(command.givenName, command.familyName));
      if (validated !== undefined) {
        nextPersonName = validated;
      }
    }

    if (errors.hasErrors()) {
      return Result.err(errors.toError("User profile update is invalid."));
    }

    const updated = user.updateProfile({
      displayName: nextDisplayName,
      personName: nextPersonName,
    });
    await this.userRepository.save(updated);

    return Result.ok(updated);
  }
}
