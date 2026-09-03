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
 * Runs work spanning more than one aggregate atomically.
 *
 * `CreateOrganization` (Issue 034) is the motivating case: it writes an
 * `Organization` *and* the owner's `OrganizationMembership`, and an
 * organization that exists with no owner-member is a corrupt state no
 * subsequent code knows how to interpret. Two independent `save` calls can
 * produce exactly that if the process dies between them.
 *
 * The port deliberately hands the caller a *set of repositories* rather than
 * exposing a transaction handle. A use case must not know whether it's inside
 * a Postgres transaction, a savepoint, or an in-memory fake — it only needs
 * the guarantee that everything in the callback commits together or not at
 * all. Leaking a `PrismaTransactionClient` here would put an ORM type in the
 * application layer and undo the point of the ports (see
 * docs/guides/domain-modeling.md).
 *
 * Contract:
 * - If `work` resolves, every write inside it is committed together.
 * - If `work` throws or rejects, every write inside it is rolled back and the
 *   error propagates. Returning a `Result.err` is **not** a rollback signal —
 *   an expected domain failure is a normal outcome, and by the time one is
 *   returned nothing should have been written anyway.
 */
export interface UnitOfWork {
  run<T>(work: (repositories: IdentityRepositories) => Promise<T>): Promise<T>;
}
