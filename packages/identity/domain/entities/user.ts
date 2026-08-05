import {
  createId,
  type DomainEvent,
  type Id,
  Result,
  ValidationError,
} from "@verixa/shared-kernel";

import { UserProfileUpdated } from "../events/user-profile-updated.js";
import { UserRegistered } from "../events/user-registered.js";
import { UserStatusChanged } from "../events/user-status-changed.js";
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
  readonly domainEvents?: readonly DomainEvent[];
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
  private readonly domainEvents: readonly DomainEvent[];

  private constructor(props: UserProps) {
    this.id = props.id;
    this.email = props.email;
    this.displayName = props.displayName;
    this.personName = props.personName;
    this.status = props.status;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
    this.domainEvents = props.domainEvents ?? [];
  }

  /** Creates a brand-new user in `pending` status (not yet email-verified). Records a {@link UserRegistered} event. */
  static register(params: {
    email: Email;
    displayName: DisplayName;
    personName?: PersonName | undefined;
  }): User {
    const now = new Date();
    const id = createId<"UserId">();
    return new User({
      id,
      email: params.email,
      displayName: params.displayName,
      personName: params.personName,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      domainEvents: [new UserRegistered(id, params.email.value)],
    });
  }

  /**
   * Rebuilds a `User` from already-trusted data (e.g. a database row read
   * back by a repository in Phase 03). Unlike {@link register}, this does not
   * go through status-transition validation — the data is assumed to already
   * represent a previously-valid state, not a new transition being made now.
   * Never carries pending domain events: a rehydrated aggregate represents
   * history that has already happened (and, if it was ever going to be
   * published, already was), not a new fact to report.
   */
  static reconstitute(props: UserProps): User {
    return new User({ ...props, domainEvents: [] });
  }

  private transitionTo(next: UserStatus, reason?: string): Result<User, ValidationError> {
    if (!ALLOWED_TRANSITIONS[this.status].has(next)) {
      return Result.err(
        new ValidationError(`Cannot transition user from "${this.status}" to "${next}".`, {
          status: [`invalid_transition_from_${this.status}`],
        }),
      );
    }

    const previousStatus = this.status;
    return Result.ok(
      new User({
        ...this,
        status: next,
        updatedAt: new Date(),
        domainEvents: [new UserStatusChanged(this.id, previousStatus, next, reason)],
      }),
    );
  }

  /**
   * Marks a `pending` or `suspended` user as `active` (e.g. after email
   * verification, or after a suspension is lifted). `reason` is optional and
   * recorded on the resulting {@link UserStatusChanged} event — admin-
   * triggered reactivation (`ReactivateUser`) always supplies one; self-
   * service email verification doesn't.
   */
  activate(reason?: string): Result<User, ValidationError> {
    return this.transitionTo("active", reason);
  }

  /** Marks an `active` user as `suspended` (e.g. a moderation or security action). */
  suspend(reason?: string): Result<User, ValidationError> {
    return this.transitionTo("suspended", reason);
  }

  /** Marks the user as `deleted`. Terminal — see {@link ALLOWED_TRANSITIONS}. */
  delete(reason?: string): Result<User, ValidationError> {
    return this.transitionTo("deleted", reason);
  }

  /**
   * Updates display name and/or person name. Unlike {@link transitionTo},
   * this can't fail: `displayName`/`personName` are already-validated value
   * objects by the time they reach here (validating raw strings is the
   * calling use case's job — see `UpdateUserProfile` — because "invalid
   * partial update" is about aggregating multiple field errors for an API
   * response, not an aggregate invariant `User` itself needs to enforce).
   */
  updateProfile(params: { displayName: DisplayName; personName: PersonName | undefined }): User {
    return new User({
      ...this,
      displayName: params.displayName,
      personName: params.personName,
      updatedAt: new Date(),
      domainEvents: [new UserProfileUpdated(this.id)],
    });
  }

  /**
   * Returns the domain event(s) produced by the action that created this
   * specific `User` instance (registration, or the one status transition
   * that produced it) — see `docs/guides/domain-events.md` for why this
   * queue holds only the latest action's events rather than an
   * accumulated history, given `User`'s immutable, returns-a-new-instance
   * design.
   */
  pullDomainEvents(): readonly DomainEvent[] {
    return this.domainEvents;
  }
}
