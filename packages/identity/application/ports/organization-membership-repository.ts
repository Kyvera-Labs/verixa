import type { OrganizationMembership } from "../../domain/entities/organization-membership.js";
import type { OrganizationId } from "../../domain/entities/organization.js";
import type { UserId } from "../../domain/entities/user.js";

/**
 * The persistence contract for `OrganizationMembership` — deliberately its
 * own port rather than a handful of extra methods bolted onto
 * `OrganizationRepository`. This is **interface segregation**: a caller that
 * only needs to check or list memberships (e.g. an authorization check
 * later in Phase 07) shouldn't have to depend on an interface that also
 * pulls in organization creation/lookup, and an in-memory fake for
 * membership queries in tests shouldn't have to stub out unrelated
 * organization methods it never calls. Two focused ports compose better than
 * one wide one.
 *
 * - `findActiveByUserAndOrganization` returns `undefined` when the user has
 *   no *active* membership in that organization — a revoked membership does
 *   not count, matching the duplicate-membership rule enforced in
 *   `OrganizationMembership.create`.
 * - `findAllByOrganization` returns every membership (active and revoked)
 *   for a given organization, e.g. for an admin membership-history view.
 * - `save` is an idempotent upsert.
 */
export interface OrganizationMembershipRepository {
  findActiveByUserAndOrganization(
    userId: UserId,
    organizationId: OrganizationId,
  ): Promise<OrganizationMembership | undefined>;
  findAllByOrganization(organizationId: OrganizationId): Promise<OrganizationMembership[]>;
  save(membership: OrganizationMembership): Promise<void>;
}
