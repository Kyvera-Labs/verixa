import { ConflictError, Result, ValidationError } from "@verixa/shared-kernel";

import { User } from "../../domain/entities/user.js";
import { DisplayName } from "../../domain/value-objects/display-name.js";
import { Email } from "../../domain/value-objects/email.js";
import { PersonName } from "../../domain/value-objects/person-name.js";
import type { UserRepository } from "../ports/user-repository.js";

export interface RegisterUserCommand {
  readonly email: string;
  readonly displayName: string;
  readonly givenName?: string;
  readonly familyName?: string;
}

export type RegisterUserError = ValidationError | ConflictError;

/**
 * Orchestrates registering a new user: validate input, check email
 * uniqueness, create the aggregate, persist it. This is the first concrete
 * example of Verixa's **use case** pattern — see `docs/guides/use-cases.md`
 * for the general shape every future use case follows.
 */
export class RegisterUser {
  constructor(private readonly userRepository: UserRepository) {}

  async execute(command: RegisterUserCommand): Promise<Result<User, RegisterUserError>> {
    const emailResult = Email.create(command.email);
    if (Result.isErr(emailResult)) {
      return emailResult;
    }

    const displayNameResult = DisplayName.create(command.displayName);
    if (Result.isErr(displayNameResult)) {
      return displayNameResult;
    }

    let personName: PersonName | undefined;
    if (command.givenName !== undefined) {
      const personNameResult = PersonName.create(command.givenName, command.familyName);
      if (Result.isErr(personNameResult)) {
        return personNameResult;
      }
      personName = personNameResult.value;
    }

    // Checked before any write — a duplicate email is a normal, expected
    // outcome (someone re-registering, or a mistyped-then-corrected signup
    // form resubmitting), not a reason to have already touched the store.
    const alreadyRegistered = await this.userRepository.existsByEmail(emailResult.value);
    if (alreadyRegistered) {
      return Result.err(
        new ConflictError(`A user with email "${emailResult.value.value}" already exists.`),
      );
    }

    const user = User.register({
      email: emailResult.value,
      displayName: displayNameResult.value,
      personName,
    });

    await this.userRepository.save(user);

    return Result.ok(user);
  }
}
