import {
  type MembershipStatus,
  OrganizationMembership,
  type OrganizationMembershipId,
  type OrganizationId,
  type UserId,
} from "@verixa/identity";
import { asId, createId } from "@verixa/shared-kernel";

import { unwrapResult } from "./result-helper.js";

export interface OrganizationMembershipFactoryOptions {
  id?: OrganizationMembershipId | string;
  userId?: UserId | string;
  organizationId?: OrganizationId | string;
  status?: MembershipStatus;
  joinedAt?: Date;
}

/**
 * Creates a domain-valid `OrganizationMembership` entity with sensible defaults and overrides.
 */
export function makeOrganizationMembership(
  overrides: OrganizationMembershipFactoryOptions = {},
): OrganizationMembership {
  const userId = (overrides.userId
    ? typeof overrides.userId === "string"
      ? asId<"UserId">(overrides.userId)
      : overrides.userId
    : createId<"UserId">()) as unknown as UserId;

  const organizationId = (overrides.organizationId
    ? typeof overrides.organizationId === "string"
      ? asId<"OrganizationId">(overrides.organizationId)
      : overrides.organizationId
    : createId<"OrganizationId">()) as unknown as OrganizationId;

  const membershipResult = OrganizationMembership.create({
    userId,
    organizationId,
  });

  let membership = unwrapResult(membershipResult);

  if (overrides.id || overrides.status || overrides.joinedAt) {
    const id = overrides.id
      ? typeof overrides.id === "string"
        ? asId<"OrganizationMembershipId">(overrides.id)
        : overrides.id
      : membership.id;

    membership = OrganizationMembership.reconstitute({
      id,
      userId: membership.userId,
      organizationId: membership.organizationId,
      status: overrides.status ?? membership.status,
      joinedAt: overrides.joinedAt ?? membership.joinedAt,
    });
  }

  return membership;
}
