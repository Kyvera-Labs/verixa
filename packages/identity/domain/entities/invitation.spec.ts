import { createHash } from "node:crypto";

import { asId, Result } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import { OrganizationInvitationCreated } from "../events/organization-invitation-created.js";
import { Email } from "../value-objects/email.js";

import { Invitation } from "./invitation.js";

const ORGANIZATION_ID = asId<"OrganizationId">("00000000-0000-0000-0000-000000000001");
const INVITER_ID = asId<"UserId">("00000000-0000-0000-0000-000000000002");

function issue(ttlMs?: number): { invitation: Invitation; token: string } {
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
    const { invitation } = issue();

    expect(invitation.status).toBe("pending");
    expect(invitation.isExpired()).toBe(false);
    expect(invitation.tokenHash).toBeTruthy();
    expect(invitation.tokenHash).not.toBe(invitation.id);
  });

  it("records an OrganizationInvitationCreated event on creation", () => {
    const { invitation } = issue();
    const events = invitation.pullDomainEvents();

    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(OrganizationInvitationCreated);
    expect(events[0]?.aggregateId).toBe(invitation.id);
  });

  it("is expired once now is past expiresAt", () => {
    const { invitation } = issue(1000);

    expect(invitation.isExpired(new Date(invitation.expiresAt.getTime() + 1))).toBe(true);
  });

  it("accepts a pending, unexpired invitation", () => {
    const { invitation } = issue();
    const result = invitation.accept();

    expect(Result.isOk(result) && result.value.status).toBe("accepted");
    expect(Result.isOk(result) && result.value.acceptedAt).toBeInstanceOf(Date);
  });

  it("rejects accepting an already-accepted invitation (single-use)", () => {
    const { invitation } = issue();
    const accepted = invitation.accept();
    if (!Result.isOk(accepted)) throw new Error("fixture setup failed");

    const result = accepted.value.accept();

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.fieldErrors["status"]).toContain("already_accepted");
    }
  });

  it("rejects accepting a revoked invitation", () => {
    const { invitation } = issue();
    const revoked = invitation.revoke();

    const result = revoked.accept();

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.fieldErrors["status"]).toContain("revoked");
    }
  });

  it("rejects accepting an expired invitation", () => {
    const { invitation } = issue(1000);
    const now = new Date(invitation.expiresAt.getTime() + 1);

    const result = invitation.accept(now);

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.fieldErrors["status"]).toContain("expired");
    }
  });

  it("never exposes the raw token on the entity", () => {
    const { invitation, token } = issue();

    // The raw token exists only in `create`'s return value. Anything that
    // reaches persistence carries the hash and nothing else — so a database
    // disclosure yields no usable credential.
    expect(Object.values({ ...invitation })).not.toContain(token);
    expect(invitation.tokenHash).not.toBe(token);
  });

  it("hashes the token with SHA-256, so the stored form is irreversible", () => {
    const { invitation, token } = issue();

    expect(invitation.tokenHash).toBe(createHash("sha256").update(token, "utf8").digest("hex"));
    expect(invitation.tokenHash).toHaveLength(64);
  });

  it("matches its own raw token", () => {
    const { invitation, token } = issue();

    expect(invitation.matchesToken(token)).toBe(true);
  });

  it("does not match a different token", () => {
    const { invitation } = issue();
    const other = issue();

    expect(invitation.matchesToken(other.token)).toBe(false);
    expect(invitation.matchesToken("not-a-token")).toBe(false);
  });

  it("issues a distinct token per invitation", () => {
    const first = issue();
    const second = issue();

    expect(first.token).not.toBe(second.token);
    expect(first.invitation.tokenHash).not.toBe(second.invitation.tokenHash);
  });

  it("revoke is idempotent and a no-op once already accepted", () => {
    const { invitation } = issue();
    const accepted = invitation.accept();
    if (!Result.isOk(accepted)) throw new Error("fixture setup failed");

    const revoked = accepted.value.revoke();

    expect(revoked.status).toBe("accepted");
  });
});
