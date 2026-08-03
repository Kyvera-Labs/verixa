import { createId, type Id, Result, ValidationError } from "@verixa/shared-kernel";

import type { DisplayName } from "../value-objects/display-name.js";
import type { Email } from "../value-objects/email.js";
import type { PersonName } from "../value-objects/person-name.js";

export type UserId = Id<"UserId">;

export type UserStatus = "pending" | "active" | "suspended" | "deleted";

/**
 * Status transitions a `User` may legally make. `deleted` has no outgoing
 * transitions — deletion is terminal by design (see {@link User.delete}); a
 * "deleted" user is re-onboarded as a brand-new registration, not reactivated,
 * so any history/audit trail tied to the old identity stays intact.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<UserStatus, ReadonlySet<UserStatus>>> = {
  pending: new Set<UserStatus>(["active", "deleted"]),
  active: new Set<UserStatus>(["suspended", "deleted"]),
  suspended: new Set<UserStatus>(["active", "deleted"]),
  deleted: new Set<UserStatus>([]),
};

interface UserProps {
  readonly id: UserId;
  readonly email: Email;
  readonly displayName: DisplayName;
  readonly personName: PersonName | undefined;
  readonly status: UserStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * The identity aggregate root. Every other bounded context references a user
 * by {@link UserId} alone, never by holding a `User` instance — that keeps
 * contexts decoupled from identity's internals and avoids one context
 * accidentally depending on fields (or invariants) that only make sense
 * within identity itself. See `docs/guides/domain-modeling.md` for the full
 * rationale.
 */
export class User {
  readonly id: UserId;
  readonly email: Email;
  readonly displayName: DisplayName;
  readonly personName: PersonName | undefined;
  readonly status: UserStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;

  private constructor(props: UserProps) {
    this.id = props.id;
    this.email = props.email;
    this.displayName = props.displayName;
    this.personName = props.personName;
    this.status = props.status;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  /** Creates a brand-new user in `pending` status (not yet email-verified). */
  static register(params: {
    email: Email;
    displayName: DisplayName;
    personName?: PersonName | undefined;
  }): User {
    const now = new Date();
    return new User({
      id: createId<"UserId">(),
      email: params.email,
      displayName: params.displayName,
      personName: params.personName,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
  }

  /**
   * Rebuilds a `User` from already-trusted data (e.g. a database row read
   * back by a repository in Phase 03). Unlike {@link register}, this does not
   * go through status-transition validation — the data is assumed to already
   * represent a previously-valid state, not a new transition being made now.
   */
  static reconstitute(props: UserProps): User {
    return new User(props);
  }

  private transitionTo(next: UserStatus): Result<User, ValidationError> {
    if (!ALLOWED_TRANSITIONS[this.status].has(next)) {
      return Result.err(
        new ValidationError(`Cannot transition user from "${this.status}" to "${next}".`, {
          status: [`invalid_transition_from_${this.status}`],
        }),
      );
    }

    return Result.ok(new User({ ...this, status: next, updatedAt: new Date() }));
  }

  /** Marks a `pending` or `suspended` user as `active` (e.g. after email verification, or after a suspension is lifted). */
  activate(): Result<User, ValidationError> {
    return this.transitionTo("active");
  }

  /** Marks an `active` user as `suspended` (e.g. a moderation or security action). */
  suspend(): Result<User, ValidationError> {
    return this.transitionTo("suspended");
  }

  /** Marks the user as `deleted`. Terminal — see {@link ALLOWED_TRANSITIONS}. */
  delete(): Result<User, ValidationError> {
    return this.transitionTo("deleted");
  }
}
