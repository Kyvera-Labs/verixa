import type { IdentityRepositories, UnitOfWork } from "../../application/ports/unit-of-work.js";

import { InMemoryInvitationRepository } from "./in-memory-invitation-repository.js";
import { InMemoryOrganizationMembershipRepository } from "./in-memory-organization-membership-repository.js";
import { InMemoryOrganizationRepository } from "./in-memory-organization-repository.js";
import { InMemoryUserRepository } from "./in-memory-user-repository.js";

/**
 * `UnitOfWork` over the in-memory fakes, for testing use cases without a
 * database.
 *
 * **This does not roll back.** It runs the callback against long-lived
 * in-memory repositories and returns the result; if the callback throws,
 * writes already made remain. Implementing real rollback would mean
 * snapshotting and restoring every store, which is achievable but would make
 * the fake's behavior depend on a mechanism nothing in production shares —
 * a test passing against a hand-rolled rollback says little about whether
 * Postgres will actually roll back.
 *
 * The honest split: use-case tests here verify *orchestration* (was the
 * membership created alongside the organization, is the right error returned)
 * against these fakes, and atomicity is verified separately against a real
 * database, where the guarantee actually lives. See
 * `prisma-repositories.spec.ts`.
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
