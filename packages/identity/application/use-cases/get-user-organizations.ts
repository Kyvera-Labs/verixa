import { Result } from "@verixa/shared-kernel";

import type { Organization } from "../../domain/entities/organization.js";
import type { UserId } from "../../domain/entities/user.js";
import type { OrganizationMembershipRepository } from "../ports/organization-membership-repository.js";
import type { OrganizationRepository } from "../ports/organization-repository.js";

export interface GetUserOrganizationsCommand {
  readonly userId: UserId;
}

/**
 * Retrieves all active organizations a user belongs to.
 *
 * Fetches user memberships, filters active ones, and batch-loads
 * matching `Organization` aggregates in a single repository call.
 */
export class GetUserOrganizations {
  constructor(
    private readonly membershipRepository: OrganizationMembershipRepository,
    private readonly organizationRepository: OrganizationRepository,
  ) {}

  async execute(command: GetUserOrganizationsCommand): Promise<Result<Organization[], never>> {
    const memberships = await this.membershipRepository.findAllByUser(command.userId);
    const activeMemberships = memberships.filter((m) => m.status === "active");
    if (activeMemberships.length === 0) {
      return Result.ok([]);
    }
    const orgIds = activeMemberships.map((m) => m.organizationId);
    const orgs = await this.organizationRepository.findManyByIds(orgIds);
    return Result.ok(orgs);
  }
}
