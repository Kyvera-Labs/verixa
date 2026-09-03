import { Result, ValidationError } from "@verixa/shared-kernel";

import { Invitation, type IssuedInvitation } from "../../domain/entities/invitation.js";
import type { OrganizationId } from "../../domain/entities/organization.js";
import type { UserId } from "../../domain/entities/user.js";
import { Email } from "../../domain/value-objects/email.js";
import type { InvitationRepository } from "../ports/invitation-repository.js";

export interface InviteUserToOrganizationCommand {
  readonly organizationId: OrganizationId;
  readonly email: string;
  readonly invitedByUserId: UserId;
}

export type InviteUserToOrganizationError = ValidationError;

/**
 * Creates a pending `Invitation` for `email` to join `organizationId`. This
 * is the domain-skeleton half of org invitations (Issue 035) — it validates
 * input and persists the invitation, but doesn't send anything: there's no
 * email adapter until Phase 14 (Notifications). The invitation's `token`
 * exists and is ready to be mailed the moment that adapter does.
 */
export class InviteUserToOrganization {
  constructor(private readonly invitationRepository: InvitationRepository) {}

  async execute(
    command: InviteUserToOrganizationCommand,
  ): Promise<Result<IssuedInvitation, InviteUserToOrganizationError>> {
    const emailResult = Email.create(command.email);
    if (Result.isErr(emailResult)) {
      return emailResult;
    }

    const issued = Invitation.create({
      organizationId: command.organizationId,
      email: emailResult.value,
      invitedByUserId: command.invitedByUserId,
    });

    await this.invitationRepository.save(issued.invitation);

    return Result.ok(issued);
  }
}
