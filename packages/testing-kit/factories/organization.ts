import {
  Organization,
  type OrganizationId,
  type OrganizationStatus,
  type UserId,
} from "@verixa/identity";
import { asId, createId } from "@verixa/shared-kernel";

import { unwrapResult } from "./result-helper.js";

let orgCounter = 0;

export interface OrganizationFactoryOptions {
  id?: OrganizationId | string;
  name?: string;
  slug?: string;
  ownerId?: UserId | string;
  status?: OrganizationStatus;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Creates a domain-valid `Organization` aggregate with sensible defaults and optional field overrides.
 */
export function makeOrganization(overrides: OrganizationFactoryOptions = {}): Organization {
  orgCounter += 1;

  const name = overrides.name ?? `Organization ${orgCounter}`;
  const slug = overrides.slug ?? `org-${orgCounter}-${Date.now().toString(36)}`;
  const ownerId = (overrides.ownerId
    ? typeof overrides.ownerId === "string"
      ? asId<"UserId">(overrides.ownerId)
      : overrides.ownerId
    : createId<"UserId">()) as unknown as UserId;

  const orgResult = Organization.create({
    name,
    slug,
    ownerId,
  });

  let org = unwrapResult(orgResult);

  if (overrides.id || overrides.status || overrides.createdAt || overrides.updatedAt) {
    const id = overrides.id
      ? typeof overrides.id === "string"
        ? asId<"OrganizationId">(overrides.id)
        : overrides.id
      : org.id;

    org = Organization.reconstitute({
      id,
      name: org.name,
      slug: org.slug,
      status: overrides.status ?? org.status,
      ownerId: org.ownerId,
      createdAt: overrides.createdAt ?? org.createdAt,
      updatedAt: overrides.updatedAt ?? org.updatedAt,
    });
  }

  return org;
}
