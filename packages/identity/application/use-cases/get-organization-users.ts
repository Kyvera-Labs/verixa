import { Result } from "@verixa/shared-kernel";

import type { OrganizationId } from "../../domain/entities/organization.js";
import type { User } from "../../domain/entities/user.js";
import type { OrganizationMembershipRepository } from "../ports/organization-membership-repository.js";
import type { UserRepository } from "../ports/user-repository.js";

export interface GetOrganizationUsersCommand {
  readonly organizationId: OrganizationId;
}

/**
 * Retrieves all active users belonging to an organization.
 *
 * To avoid the N+1 query problem, memberships for the organization are fetched
 * in a single query, active member user IDs are extracted, and matching `User`
 * aggregates are loaded in one batched `findManyByIds` call.
 */
export class GetOrganizationUsers {
  constructor(
    private readonly membershipRepository: OrganizationMembershipRepository,
    private readonly userRepository: UserRepository,
  ) {}

  async execute(command: GetOrganizationUsersCommand): Promise<Result<User[], never>> {
    const memberships = await this.membershipRepository.findAllByOrganization(
      command.organizationId,
    );
    const activeMemberships = memberships.filter((m) => m.status === "active");
    if (activeMemberships.length === 0) {
      return Result.ok([]);
    }
    const userIds = activeMemberships.map((m) => m.userId);
    const users = await this.userRepository.findManyByIds(userIds);
    return Result.ok(users);
  }
}
