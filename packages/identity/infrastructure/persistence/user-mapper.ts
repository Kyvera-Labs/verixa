import type { UserRow } from "@verixa/database";
import { asId, Result } from "@verixa/shared-kernel";

import { User } from "../../domain/entities/user.js";
import { DisplayName } from "../../domain/value-objects/display-name.js";
import { Email } from "../../domain/value-objects/email.js";
import { PersonName } from "../../domain/value-objects/person-name.js";

/**
 * Translates between the `users` row shape and the `User` aggregate.
 *
 * This file is the entire reason `@verixa/database` never appears in the
 * domain or application layers: everything Prisma-shaped stops here. Without
 * an explicit mapper the natural shortcut is to let Prisma's generated types
 * *be* the domain model — which works right up until the schema needs to
 * change for a database reason and every layer changes with it, or until
 * something constructs a "User" that never passed a single domain
 * invariant.
 *
 * The mapping is deliberately manual rather than a generic
 * object-to-object mapper. It's more code, and it's the code that would
 * otherwise silently do the wrong thing: `Email`, `DisplayName`, and
 * `PersonName` are validated value objects, not strings, and reconstructing
 * them is the step where a generic mapper would just assign a string and
 * produce a structurally-valid, semantically-broken aggregate.
 */
export const UserMapper = {
  /**
   * Row → aggregate.
   *
   * Uses `User.reconstitute`, not `User.register`: this data was already
   * valid when it was written, so re-running creation rules would be both
   * redundant and wrong (registration assigns a new id and a `pending`
   * status; loading must preserve what's stored).
   *
   * Value objects are rebuilt through their `create` factories anyway, and
   * a failure there is treated as a programmer/data-integrity error rather
   * than a `Result` — by construction nothing invalid should ever have been
   * written, so a failure means the database disagrees with the domain and
   * continuing would silently propagate corruption. Throwing is the correct
   * response to a broken invariant (see docs/guides/error-handling.md).
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
    };
  },
};
