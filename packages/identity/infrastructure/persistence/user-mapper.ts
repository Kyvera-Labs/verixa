import type { UserRow } from "@verixa/database";
import { asId, Result } from "@verixa/shared-kernel";

import { User } from "../../domain/entities/user.js";
import { DisplayName } from "../../domain/value-objects/display-name.js";
import { Email } from "../../domain/value-objects/email.js";
import { PersonName } from "../../domain/value-objects/person-name.js";

/**
 * Translates between `users` rows and the `User` aggregate, keeping Prisma types out of the domain
 * and application layers. Written by hand so value objects such as `Email` are rebuilt through
 * their factories rather than assigned as strings.
 */
export const UserMapper = {
  /**
   * Row to aggregate, using `User.reconstitute` so stored IDs and status are preserved. Value
   * objects are rebuilt with their `create` factories; a failure means stored data contradicts the
   * domain, so it throws rather than returning a `Result` (see docs/guides/error-handling.md).
   */
  toDomain(row: UserRow): User {
    const email = Email.create(row.email);
    if (Result.isErr(email)) {
      throw new Error(`users.id=${row.id} holds an email the domain rejects: ${row.email}`);
    }

    const displayName = DisplayName.create(row.displayName);
    if (Result.isErr(displayName)) {
      throw new Error(`users.id=${row.id} holds a display name the domain rejects.`);
    }

    let personName: PersonName | undefined;
    if (row.givenName !== null) {
      const created = PersonName.create(row.givenName, row.familyName ?? undefined);
      if (Result.isErr(created)) {
        throw new Error(`users.id=${row.id} holds a person name the domain rejects.`);
      }
      personName = created.value;
    }

    return User.reconstitute({
      id: asId<"UserId">(row.id),
      email: email.value,
      displayName: displayName.value,
      personName,
      // Safe by construction: the `user_status` Postgres enum and the domain's
      // UserStatus union hold exactly the same four values, asserted by
      // packages/database/index.spec.ts.
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt ?? undefined,
    });
  },

  /** Aggregate → row. Total and non-failing: a `User` is valid by construction. */
  toRow(user: User): UserRow {
    return {
      id: user.id,
      email: user.email.value,
      displayName: user.displayName.value,
      givenName: user.personName?.givenName ?? null,
      familyName: user.personName?.familyName ?? null,
      status: user.status,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      deletedAt: user.deletedAt ?? null,
    };
  },
};
