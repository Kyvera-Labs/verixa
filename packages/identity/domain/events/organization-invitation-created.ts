import { BaseDomainEvent } from "@verixa/shared-kernel";

import type { InvitationId } from "../entities/invitation.js";
import type { OrganizationId } from "../entities/organization.js";

/** Recorded when a new organization invitation is created (see `Invitation.create`). */
export class OrganizationInvitationCreated extends BaseDomainEvent {
  readonly eventName = "identity.organization_invitation.created";
  readonly organizationId: OrganizationId;
  readonly email: string;

  constructor(invitationId: InvitationId, organizationId: OrganizationId, email: string) {
    super(invitationId);
    this.organizationId = organizationId;
    this.email = email;
  }
}
