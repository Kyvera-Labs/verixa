import type { PrismaClient } from "@verixa/database";

import type { IdentityRepositories, UnitOfWork } from "../../application/ports/unit-of-work.js";

import { PrismaInvitationRepository } from "./prisma-invitation-repository.js";
import {
  PrismaOrganizationMembershipRepository,
  PrismaOrganizationRepository,
} from "./prisma-organization-repository.js";
import { PrismaUserRepository } from "./prisma-user-repository.js";

/**
 * `UnitOfWork` over Prisma's interactive transactions.
 *
 * `prisma.$transaction(fn)` opens a transaction, hands back a client scoped
 * to it, and commits when `fn` resolves or rolls back if it rejects. The
 * repositories constructed inside therefore all issue their statements on the
 * same connection and the same transaction — which is the entire reason every
 * Prisma repository in this package takes its client as a constructor
 * argument instead of creating one. A repository that owned its connection
 * could not be enlisted in someone else's transaction, and this pattern would
 * be impossible.
 *
 * The transaction client is structurally a `PrismaClient` minus the methods
 * that make no sense inside a transaction (`$connect`, `$transaction`, and
 * friends), so it doesn't satisfy the full `PrismaClient` type. The
 * repositories only ever use model delegates, which are present and correctly
 * typed on both — hence the narrow cast here, in the one file that knows it's
 * talking to Prisma at all.
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
