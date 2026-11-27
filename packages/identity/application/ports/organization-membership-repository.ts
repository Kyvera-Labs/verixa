import type { OrganizationMembership } from "../../domain/entities/organization-membership.js";
import type { OrganizationId } from "../../domain/entities/organization.js";
import type { UserId } from "../../domain/entities/user.js";

/**
 * Persistence port for `OrganizationMembership`, separate from `OrganizationRepository` so
 * membership checks and their test fakes do not depend on organization methods.
 *
 * - `findActiveByUserAndOrganization` returns `undefined` unless the user has an active membership;
 *   revoked memberships do not count.
 * - `findAllByOrganization` returns every membership, active and revoked.
 * - `save` is an idempotent upsert.
 */
export interface OrganizationMembershipRepository {
  findActiveByUserAndOrganization(
    userId: UserId,
    organizationId: OrganizationId,
  ): Promise<OrganizationMembership | undefined>;
  findAllByOrganization(organizationId: OrganizationId): Promise<OrganizationMembership[]>;
  findAllByUser(userId: UserId): Promise<OrganizationMembership[]>;
  findAllByOrganizationIds(
    organizationIds: readonly OrganizationId[],
  ): Promise<OrganizationMembership[]>;
  save(membership: OrganizationMembership): Promise<void>;
}
