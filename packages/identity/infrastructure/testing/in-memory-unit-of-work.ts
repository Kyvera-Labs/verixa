import type { IdentityRepositories, UnitOfWork } from "../../application/ports/unit-of-work.js";

import { InMemoryInvitationRepository } from "./in-memory-invitation-repository.js";
import { InMemoryOrganizationMembershipRepository } from "./in-memory-organization-membership-repository.js";
import { InMemoryOrganizationRepository } from "./in-memory-organization-repository.js";
import { InMemoryUserRepository } from "./in-memory-user-repository.js";

/**
 * `UnitOfWork` over the in-memory fakes. It does not roll back: if the callback throws, earlier
 * writes remain. Use-case tests check orchestration here; atomicity is tested against a real
 * database in `prisma-repositories.spec.ts`.
 */
export class InMemoryUnitOfWork implements UnitOfWork {
  readonly repositories: IdentityRepositories;

  constructor(repositories?: Partial<IdentityRepositories>) {
    this.repositories = {
      users: repositories?.users ?? new InMemoryUserRepository(),
      organizations: repositories?.organizations ?? new InMemoryOrganizationRepository(),
      memberships: repositories?.memberships ?? new InMemoryOrganizationMembershipRepository(),
      invitations: repositories?.invitations ?? new InMemoryInvitationRepository(),
    };
  }

  run<T>(work: (repositories: IdentityRepositories) => Promise<T>): Promise<T> {
    return work(this.repositories);
  }
}
