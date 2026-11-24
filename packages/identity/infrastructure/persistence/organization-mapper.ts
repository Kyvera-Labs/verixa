import type { OrganizationMembershipRow, OrganizationRow } from "@verixa/database";
import { asId } from "@verixa/shared-kernel";

import { OrganizationMembership } from "../../domain/entities/organization-membership.js";
import { Organization } from "../../domain/entities/organization.js";

/** Row ↔ aggregate translation for `Organization`. See `user-mapper.ts` for why mappers exist at all. */
export const OrganizationMapper = {
  toDomain(row: OrganizationRow): Organization {
    // `create` would reject nothing here that the database could hold, but it
    // also mints a fresh id and timestamps — wrong for loading. `reconstitute`
    // preserves stored state, which is what a read must do.
    return Organization.reconstitute({
      id: asId<"OrganizationId">(row.id),
      name: row.name,
      slug: row.slug,
      ownerId: asId<"UserId">(row.ownerId),
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  },

  toRow(organization: Organization): OrganizationRow {
    return {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      ownerId: organization.ownerId,
      status: organization.status,
      createdAt: organization.createdAt,
      updatedAt: organization.updatedAt,
    };
  },
};

/** Row ↔ aggregate translation for `OrganizationMembership`. */
export const OrganizationMembershipMapper = {
  toDomain(row: OrganizationMembershipRow): OrganizationMembership {
    return OrganizationMembership.reconstitute({
      id: asId<"OrganizationMembershipId">(row.id),
      userId: asId<"UserId">(row.userId),
      organizationId: asId<"OrganizationId">(row.organizationId),
      status: row.status,
      joinedAt: row.joinedAt,
    });
  },

  toRow(membership: OrganizationMembership): OrganizationMembershipRow {
    return {
      id: membership.id,
      userId: membership.userId,
      organizationId: membership.organizationId,
      status: membership.status,
      joinedAt: membership.joinedAt,
    };
  },
};
