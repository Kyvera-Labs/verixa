import {
  DisplayName,
  Email,
  PersonName,
  User,
  type UserId,
  type UserStatus,
} from "@verixa/identity";
import { asId } from "@verixa/shared-kernel";

import { unwrapResult } from "./result-helper.js";

let userCounter = 0;

export interface UserFactoryOptions {
  id?: UserId | string;
  email?: Email | string;
  displayName?: DisplayName | string;
  personName?: PersonName | string;
  status?: UserStatus;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Creates a domain-valid `User` aggregate with sensible defaults and optional field overrides.
 * Guarantees domain invariants (valid email, display name, and legal status transitions).
 */
export function makeUser(overrides: UserFactoryOptions = {}): User {
  userCounter += 1;

  const email =
    overrides.email instanceof Email
      ? overrides.email
      : typeof overrides.email === "string"
        ? unwrapResult(Email.create(overrides.email))
        : unwrapResult(Email.create(`user-${userCounter}-${Date.now()}@example.com`));

  const displayName =
    overrides.displayName instanceof DisplayName
      ? overrides.displayName
      : typeof overrides.displayName === "string"
        ? unwrapResult(DisplayName.create(overrides.displayName))
        : unwrapResult(DisplayName.create(`Test User ${userCounter}`));

  const personName =
    overrides.personName instanceof PersonName
      ? overrides.personName
      : typeof overrides.personName === "string"
        ? unwrapResult(PersonName.create(overrides.personName))
        : undefined;

  let user = User.register({
    email,
    displayName,
    personName,
  });

  const targetStatus = overrides.status ?? "pending";
  const now = new Date();
  const isDeleted = targetStatus === "deleted";

  if (overrides.id || overrides.createdAt || overrides.updatedAt || isDeleted) {
    const id = overrides.id
      ? typeof overrides.id === "string"
        ? asId<"UserId">(overrides.id)
        : overrides.id
      : user.id;

    user = User.reconstitute({
      id,
      email: user.email,
      displayName: user.displayName,
      personName: user.personName,
      status: targetStatus,
      createdAt: overrides.createdAt ?? user.createdAt,
      updatedAt: overrides.updatedAt ?? user.updatedAt,
      deletedAt: isDeleted ? (overrides.updatedAt ?? now) : undefined,
    });
  } else if (targetStatus === "active") {
    user = unwrapResult(user.activate());
  } else if (targetStatus === "suspended") {
    user = unwrapResult(unwrapResult(user.activate()).suspend());
  }

  return user;
}
