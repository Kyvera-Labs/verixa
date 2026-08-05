import { asId, Result } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import { OrganizationInvitationCreated } from "../events/organization-invitation-created.js";
import { Email } from "../value-objects/email.js";

import { Invitation } from "./invitation.js";

const ORGANIZATION_ID = asId<"OrganizationId">("00000000-0000-0000-0000-000000000001");
const INVITER_ID = asId<"UserId">("00000000-0000-0000-0000-000000000002");

function makeInvitation(ttlMs?: number): Invitation {
  const email = Email.create("invitee@example.com");
  if (!Result.isOk(email)) throw new Error("test fixture setup failed");
  return Invitation.create({
    organizationId: ORGANIZATION_ID,
    email: email.value,
    invitedByUserId: INVITER_ID,
    ...(ttlMs !== undefined ? { ttlMs } : {}),
  });
}

describe("Invitation", () => {
  it("is created as pending, unexpired, with a unique token", () => {
    const invitation = makeInvitation();

    expect(invitation.status).toBe("pending");
    expect(invitation.isExpired()).toBe(false);
    expect(invitation.token).toBeTruthy();
    expect(invitation.token).not.toBe(invitation.id);
  });

  it("records an OrganizationInvitationCreated event on creation", () => {
    const invitation = makeInvitation();
    const events = invitation.pullDomainEvents();

    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(OrganizationInvitationCreated);
    expect(events[0]?.aggregateId).toBe(invitation.id);
  });

  it("is expired once now is past expiresAt", () => {
    const invitation = makeInvitation(1000);

    expect(invitation.isExpired(new Date(invitation.expiresAt.getTime() + 1))).toBe(true);
  });

  it("accepts a pending, unexpired invitation", () => {
    const invitation = makeInvitation();
    const result = invitation.accept();

    expect(Result.isOk(result) && result.value.status).toBe("accepted");
    expect(Result.isOk(result) && result.value.acceptedAt).toBeInstanceOf(Date);
  });

  it("rejects accepting an already-accepted invitation (single-use)", () => {
    const invitation = makeInvitation();
    const accepted = invitation.accept();
    if (!Result.isOk(accepted)) throw new Error("fixture setup failed");

    const result = accepted.value.accept();

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.fieldErrors["status"]).toContain("already_accepted");
    }
  });

  it("rejects accepting a revoked invitation", () => {
    const invitation = makeInvitation().revoke();

    const result = invitation.accept();

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.fieldErrors["status"]).toContain("revoked");
    }
  });

  it("rejects accepting an expired invitation", () => {
    const invitation = makeInvitation(1000);
    const now = new Date(invitation.expiresAt.getTime() + 1);

    const result = invitation.accept(now);

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.fieldErrors["status"]).toContain("expired");
    }
  });

  it("revoke is idempotent and a no-op once already accepted", () => {
    const invitation = makeInvitation();
    const accepted = invitation.accept();
    if (!Result.isOk(accepted)) throw new Error("fixture setup failed");

    const revoked = accepted.value.revoke();

    expect(revoked.status).toBe("accepted");
  });
});
