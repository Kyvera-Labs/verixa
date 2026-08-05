import type { OrganizationMembershipRepository } from "../../application/ports/organization-membership-repository.js";
import type {
  OrganizationMembership,
  OrganizationMembershipId,
} from "../../domain/entities/organization-membership.js";
import type { OrganizationId } from "../../domain/entities/organization.js";
import type { UserId } from "../../domain/entities/user.js";

/** In-memory `OrganizationMembershipRepository` — see `in-memory-user-repository.ts` for the rationale. */
export class InMemoryOrganizationMembershipRepository implements OrganizationMembershipRepository {
  private readonly membershipsById = new Map<OrganizationMembershipId, OrganizationMembership>();

  findActiveByUserAndOrganization(
    userId: UserId,
    organizationId: OrganizationId,
  ): Promise<OrganizationMembership | undefined> {
    return Promise.resolve(
      [...this.membershipsById.values()].find(
        (membership) =>
          membership.userId === userId &&
          membership.organizationId === organizationId &&
          membership.status === "active",
      ),
    );
  }

  findAllByOrganization(organizationId: OrganizationId): Promise<OrganizationMembership[]> {
    return Promise.resolve(
      [...this.membershipsById.values()].filter(
        (membership) => membership.organizationId === organizationId,
      ),
    );
  }

  save(membership: OrganizationMembership): Promise<void> {
    this.membershipsById.set(membership.id, membership);
    return Promise.resolve();
  }
}
