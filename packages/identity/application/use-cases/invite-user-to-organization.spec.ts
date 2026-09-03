import { asId, Result } from "@verixa/shared-kernel";
import { beforeEach, describe, expect, it } from "vitest";

import type { OrganizationId } from "../../domain/entities/organization.js";
import type { UserId } from "../../domain/entities/user.js";
import { InMemoryInvitationRepository } from "../../infrastructure/testing/in-memory-invitation-repository.js";

import { InviteUserToOrganization } from "./invite-user-to-organization.js";

const ORGANIZATION_ID: OrganizationId = asId("00000000-0000-0000-0000-000000000001");
const INVITER_ID: UserId = asId("00000000-0000-0000-0000-000000000002");

describe("InviteUserToOrganization", () => {
  let repository: InMemoryInvitationRepository;
  let inviteUserToOrganization: InviteUserToOrganization;

  beforeEach(() => {
    repository = new InMemoryInvitationRepository();
    inviteUserToOrganization = new InviteUserToOrganization(repository);
  });

  it("creates and persists a pending invitation", async () => {
    const result = await inviteUserToOrganization.execute({
      organizationId: ORGANIZATION_ID,
      email: "invitee@example.com",
      invitedByUserId: INVITER_ID,
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.invitation.status).toBe("pending");
      expect(result.value.invitation.email.value).toBe("invitee@example.com");
      await expect(repository.findById(result.value.invitation.id)).resolves.toBe(
        result.value.invitation,
      );
      await expect(repository.findByToken(result.value.token)).resolves.toBe(
        result.value.invitation,
      );
    }
  });

  it("emits an OrganizationInvitationCreated event", async () => {
    const result = await inviteUserToOrganization.execute({
      organizationId: ORGANIZATION_ID,
      email: "invitee@example.com",
      invitedByUserId: INVITER_ID,
    });

    expect(Result.isOk(result) && result.value.invitation.pullDomainEvents()).toHaveLength(1);
  });

  it("rejects an invalid email without persisting anything", async () => {
    const result = await inviteUserToOrganization.execute({
      organizationId: ORGANIZATION_ID,
      email: "not-an-email",
      invitedByUserId: INVITER_ID,
    });

    expect(Result.isErr(result)).toBe(true);
    await expect(repository.findByToken("anything")).resolves.toBeUndefined();
  });
});
