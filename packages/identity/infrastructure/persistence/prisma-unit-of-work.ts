import type { PrismaClient } from "@verixa/database";

import type { IdentityRepositories, UnitOfWork } from "../../application/ports/unit-of-work.js";

import { PrismaInvitationRepository } from "./prisma-invitation-repository.js";
import {
  PrismaOrganizationMembershipRepository,
  PrismaOrganizationRepository,
} from "./prisma-organization-repository.js";
import { PrismaUserRepository } from "./prisma-user-repository.js";

/**
 * `UnitOfWork` over Prisma interactive transactions. Repositories are constructed with the
 * transaction client, so all their statements share one transaction; this is why repositories take
 * a client instead of creating one. The cast is needed because a transaction client lacks methods
 * such as `$connect` and `$transaction`, which the repositories never use.
 */
export class PrismaUnitOfWork implements UnitOfWork {
  constructor(private readonly prisma: PrismaClient) {}

  run<T>(work: (repositories: IdentityRepositories) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => {
      const client = tx as unknown as PrismaClient;

      const repositories: IdentityRepositories = {
        users: new PrismaUserRepository(client),
        organizations: new PrismaOrganizationRepository(client),
        memberships: new PrismaOrganizationMembershipRepository(client),
        invitations: new PrismaInvitationRepository(client),
      };

      return work(repositories);
    });
  }
}
