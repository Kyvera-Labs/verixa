import { Result } from "@verixa/shared-kernel";

import type { OrganizationId } from "../../domain/entities/organization.js";
import type { User, UserId } from "../../domain/entities/user.js";
import type { OrganizationMembershipRepository } from "../ports/organization-membership-repository.js";
import type { UserRepository } from "../ports/user-repository.js";

export interface GetUsersByOrganizationIdsCommand {
  readonly organizationIds: readonly OrganizationId[];
}

/**
 * Batched use case for DataLoader / Mercurius loaders: given multiple
 * organization IDs, returns a mapping from OrganizationId to User[].
 *
 * Executes exactly 2 repository calls regardless of how many organizations
 * are requested:
 * 1. Find memberships across all requested organization IDs
 * 2. Find unique users across all active memberships
 */
export class GetUsersByOrganizationIds {
  constructor(
    private readonly membershipRepository: OrganizationMembershipRepository,
    private readonly userRepository: UserRepository,
  ) {}

  async execute(
    command: GetUsersByOrganizationIdsCommand,
  ): Promise<Result<Map<OrganizationId, User[]>, never>> {
    const result = new Map<OrganizationId, User[]>();
    for (const orgId of command.organizationIds) {
      result.set(orgId, []);
    }

    if (command.organizationIds.length === 0) {
      return Result.ok(result);
    }

    const memberships = await this.membershipRepository.findAllByOrganizationIds(
      command.organizationIds,
    );
    const activeMemberships = memberships.filter((m) => m.status === "active");
    const userIds = [...new Set(activeMemberships.map((m) => m.userId))];

    if (userIds.length === 0) {
      return Result.ok(result);
    }

    const users = await this.userRepository.findManyByIds(userIds);
    const userMap = new Map<UserId, User>(users.map((u) => [u.id, u]));

    for (const membership of activeMemberships) {
      const user = userMap.get(membership.userId);
      if (user !== undefined) {
        const orgUsers = result.get(membership.organizationId);
        if (orgUsers !== undefined) {
          orgUsers.push(user);
        }
      }
    }

    return Result.ok(result);
  }
}
