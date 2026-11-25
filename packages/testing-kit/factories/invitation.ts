import {
  Email,
  Invitation,
  type InvitationId,
  type InvitationStatus,
  type OrganizationId,
  type UserId,
} from "@verixa/identity";
import { asId, createId } from "@verixa/shared-kernel";

import { unwrapResult } from "./result-helper.js";

let inviteCounter = 0;

export interface InvitationFactoryOptions {
  id?: InvitationId | string;
  organizationId?: OrganizationId | string;
  email?: Email | string;
  invitedByUserId?: UserId | string;
  status?: InvitationStatus;
  ttlMs?: number;
  /** Creation time; `expiresAt` is `now + ttlMs`. Defaults to the wall clock. */
  now?: Date;
}

/**
 * Creates a domain-valid `Invitation` entity with sensible defaults and overrides.
 */
export function makeInvitation(overrides: InvitationFactoryOptions = {}): Invitation {
  inviteCounter += 1;

  const email =
    overrides.email instanceof Email
      ? overrides.email
      : typeof overrides.email === "string"
        ? unwrapResult(Email.create(overrides.email))
        : unwrapResult(Email.create(`invitee-${inviteCounter}@example.com`));

  const organizationId = (overrides.organizationId
    ? typeof overrides.organizationId === "string"
      ? asId<"OrganizationId">(overrides.organizationId)
      : overrides.organizationId
    : createId<"OrganizationId">()) as unknown as OrganizationId;

  const invitedByUserId = (overrides.invitedByUserId
    ? typeof overrides.invitedByUserId === "string"
      ? asId<"UserId">(overrides.invitedByUserId)
      : overrides.invitedByUserId
    : createId<"UserId">()) as unknown as UserId;

  const now = overrides.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (overrides.ttlMs ?? 7 * 24 * 60 * 60 * 1000));
  const id = (overrides.id
    ? typeof overrides.id === "string"
      ? asId<"InvitationId">(overrides.id)
      : overrides.id
    : createId<"InvitationId">()) as unknown as InvitationId;

  return Invitation.reconstitute({
    id,
    organizationId,
    email,
    invitedByUserId,
    tokenHash: "fake-sha256-token-hash-for-testing",
    status: overrides.status ?? "pending",
    createdAt: now,
    expiresAt,
    acceptedAt: overrides.status === "accepted" ? now : undefined,
  });
}
