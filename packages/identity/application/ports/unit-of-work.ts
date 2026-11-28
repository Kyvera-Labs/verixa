import type { InvitationRepository } from "./invitation-repository.js";
import type { OrganizationMembershipRepository } from "./organization-membership-repository.js";
import type { OrganizationRepository } from "./organization-repository.js";
import type { UserRepository } from "./user-repository.js";

/** The repositories available inside a unit of work, all bound to the same transaction. */
export interface IdentityRepositories {
  readonly users: UserRepository;
  readonly organizations: OrganizationRepository;
  readonly memberships: OrganizationMembershipRepository;
  readonly invitations: InvitationRepository;
}

/**
 * Runs work spanning several aggregates atomically, for example creating an organization together
 * with its owner's membership. Hands the callback a set of repositories rather than a transaction
 * handle, so use cases never see persistence types (see docs/guides/domain-modeling.md).
 *
 * - If `work` resolves, every write inside it commits together.
 * - If `work` throws or rejects, every write is rolled back and the error propagates. Returning
 *   `Result.err` is not a rollback signal.
 */
export interface UnitOfWork {
  run<T>(work: (repositories: IdentityRepositories) => Promise<T>): Promise<T>;
}
