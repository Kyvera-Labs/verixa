import { NotFoundError, Result, ValidationError } from "@verixa/shared-kernel";

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

    const fieldErrors: Record<string, string[]> = {};
    let nextDisplayName = user.displayName;
    let nextPersonName = user.personName;

    if (command.displayName !== undefined) {
      const displayNameResult = DisplayName.create(command.displayName);
      if (Result.isErr(displayNameResult)) {
        Object.assign(fieldErrors, displayNameResult.error.fieldErrors);
      } else {
        nextDisplayName = displayNameResult.value;
      }
    }

    if (command.givenName !== undefined) {
      const personNameResult = PersonName.create(command.givenName, command.familyName);
      if (Result.isErr(personNameResult)) {
        Object.assign(fieldErrors, personNameResult.error.fieldErrors);
      } else {
        nextPersonName = personNameResult.value;
      }
    }

    if (Object.keys(fieldErrors).length > 0) {
      return Result.err(new ValidationError("User profile update is invalid.", fieldErrors));
    }

    const updated = user.updateProfile({
      displayName: nextDisplayName,
      personName: nextPersonName,
    });
    await this.userRepository.save(updated);

    return Result.ok(updated);
  }
}
