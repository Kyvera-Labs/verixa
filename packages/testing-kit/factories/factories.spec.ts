import { DisplayName, Email, PersonName } from "@verixa/identity";
import { VerificationType } from "@verixa/verification";
import { describe, expect, it } from "vitest";

import {
  makeAuditEvent,
  makeCredential,
  makeInvitation,
  makeMfaMethod,
  makeOrganization,
  makeOrganizationMembership,
  makeRefreshToken,
  makeSession,
  makeUser,
  makeVerificationRequest,
  unwrapResult,
} from "./index.js";

describe("testing-kit factories (Object Mother pattern)", () => {
  describe("makeUser", () => {
    it("creates a domain-valid user with default fields", () => {
      const user = makeUser();
      expect(user.id).toBeDefined();
      expect(user.email.value).toMatch(/@example\.com$/);
      expect(user.displayName.value).toContain("Test User");
      expect(user.status).toBe("pending");
    });

    it("respects partial overrides", () => {
      const user = makeUser({
        email: "custom@verixa.dev",
        displayName: "Custom Dev",
        personName: "Alice Smith",
        status: "active",
      });
      expect(user.email.value).toBe("custom@verixa.dev");
      expect(user.displayName.value).toBe("Custom Dev");
      expect(user.personName?.givenName).toBe("Alice Smith");
      expect(user.status).toBe("active");
    });

    it("supports value object instances and suspended / deleted statuses", () => {
      const email = unwrapResult(Email.create("vo@example.com"));
      const displayName = unwrapResult(DisplayName.create("VO Name"));
      const personName = unwrapResult(PersonName.create("Jane", "Doe"));

      const user = makeUser({
        id: "usr_custom123",
        email,
        displayName,
        personName,
        status: "suspended",
      });
      expect(user.id).toBe("usr_custom123");
      expect(user.status).toBe("suspended");

      const deletedUser = makeUser({
        status: "deleted",
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-02-01"),
      });
      expect(deletedUser.status).toBe("deleted");
      expect(deletedUser.deletedAt).toBeDefined();
    });

    it("enforces domain invariants on invalid override values", () => {
      expect(() => makeUser({ email: "invalid-email-format" })).toThrow();
      expect(() => makeUser({ displayName: "" })).toThrow();
    });
  });

  describe("makeOrganization", () => {
    it("creates an organization with valid defaults and slug", () => {
      const org = makeOrganization();
      expect(org.id).toBeDefined();
      expect(org.name).toContain("Organization");
      expect(org.slug).toMatch(/^org-/);
      expect(org.status).toBe("active");
    });

    it("respects overrides including string ownerId and status", () => {
      const now = new Date();
      const org = makeOrganization({
        id: "org_custom456",
        name: "Kyvera Labs",
        slug: "kyvera-labs",
        ownerId: "usr_owner123",
        status: "suspended",
        createdAt: now,
        updatedAt: now,
      });
      expect(org.id).toBe("org_custom456");
      expect(org.name).toBe("Kyvera Labs");
      expect(org.slug).toBe("kyvera-labs");
      expect(org.ownerId).toBe("usr_owner123");
      expect(org.status).toBe("suspended");
    });
  });

  describe("makeOrganizationMembership", () => {
    it("creates valid membership link", () => {
      const membership = makeOrganizationMembership();
      expect(membership.id).toBeDefined();
      expect(membership.userId).toBeDefined();
      expect(membership.organizationId).toBeDefined();
      expect(membership.status).toBe("active");
    });

    it("supports string id overrides and revoked status", () => {
      const joinedAt = new Date("2025-01-01");
      const membership = makeOrganizationMembership({
        id: "mem_custom789",
        userId: "usr_member123",
        organizationId: "org_target456",
        status: "revoked",
        joinedAt,
      });
      expect(membership.id).toBe("mem_custom789");
      expect(membership.userId).toBe("usr_member123");
      expect(membership.organizationId).toBe("org_target456");
      expect(membership.status).toBe("revoked");
      expect(membership.joinedAt).toEqual(joinedAt);
    });
  });

  describe("makeInvitation", () => {
    it("creates an invitation with defaults", () => {
      const inv = makeInvitation();
      expect(inv.id).toBeDefined();
      expect(inv.tokenHash).toBeDefined();
      expect(inv.email.value).toMatch(/@example\.com$/);
      expect(inv.isExpired()).toBe(false);
    });

    it("supports string id and user overrides", () => {
      const inv = makeInvitation({
        id: "inv_custom123",
        organizationId: "org_123",
        invitedByUserId: "usr_inviter",
        email: "invited@example.com",
        ttlMs: 3600000,
      });
      expect(inv.id).toBe("inv_custom123");
      expect(inv.organizationId).toBe("org_123");
      expect(inv.invitedByUserId).toBe("usr_inviter");
      expect(inv.email.value).toBe("invited@example.com");
    });
  });

  describe("makeSession", () => {
    it("creates a valid session", () => {
      const session = makeSession();
      expect(session.id).toBeDefined();
      expect(session.isRevoked).toBe(false);
    });

    it("supports custom user, revocation, and custom id", () => {
      const session = makeSession({
        id: "ses_custom123",
        userId: "usr_ses_owner",
        isRevoked: true,
      });
      expect(session.id).toBe("ses_custom123");
      expect(session.userId).toBe("usr_ses_owner");
      expect(session.isRevoked).toBe(true);
    });
  });

  describe("makeRefreshToken", () => {
    it("issues a valid refresh token", () => {
      const issued = makeRefreshToken();
      expect(issued.refreshToken).toBeDefined();
      expect(issued.token).toBeDefined();
    });

    it("supports string sessionId override", () => {
      const issued = makeRefreshToken({ sessionId: "ses_parent123" });
      expect(issued.refreshToken.sessionId).toBe("ses_parent123");
    });
  });

  describe("makeCredential", () => {
    it("creates credential with default hash", () => {
      const cred = makeCredential();
      expect(cred.id).toBeDefined();
      expect(cred.passwordHash).toContain("argon2id");
    });

    it("supports custom failedAttempts and lockouts", () => {
      const lockedUntil = new Date(Date.now() + 60000);
      const cred = makeCredential({
        id: "crd_custom123",
        userId: "usr_cred_owner",
        failedAttempts: 3,
        lockedUntil,
      });
      expect(cred.id).toBe("crd_custom123");
      expect(cred.userId).toBe("usr_cred_owner");
      expect(cred.failedAttempts).toBe(3);
      expect(cred.lockedUntil).toEqual(lockedUntil);
    });
  });

  describe("makeMfaMethod", () => {
    it("creates active MFA method", () => {
      const method = makeMfaMethod();
      expect(method.id).toBeDefined();
      expect(method.type).toBe("totp");
      expect(method.status).toBe("active");
    });

    it("creates pending MFA method and supports string id", () => {
      const method = makeMfaMethod({
        id: "mfa_custom123",
        userId: "usr_mfa_owner",
        status: "pending",
        secret: "CUSTOMSECRET32CHARS",
      });
      expect(method.id).toBe("mfa_custom123");
      expect(method.userId).toBe("usr_mfa_owner");
      expect(method.status).toBe("pending");
      expect(method.secret).toBe("CUSTOMSECRET32CHARS");
    });
  });

  describe("makeAuditEvent", () => {
    it("creates valid audit event", () => {
      const event = makeAuditEvent();
      expect(event.id).toBeDefined();
      expect(event.action).toBe("identity.user.registered");
    });

    it("supports custom string organizationId and metadata", () => {
      const event = makeAuditEvent({
        action: "identity.user.suspended",
        organizationId: "org_audit_tenant",
        actorId: "actor_123",
        metadata: { reason: "Terms violation" },
      });
      expect(event.organizationId).toBe("org_audit_tenant");
      expect(event.actorId).toBe("actor_123");
      expect(event.metadata).toEqual({ reason: "Terms violation" });
    });
  });

  describe("makeVerificationRequest", () => {
    it("creates verification request with defaults", () => {
      const req = makeVerificationRequest();
      expect(req.id).toBeDefined();
      expect(req.type.value).toBe("identity-document");
    });

    it("supports string subject, org, and type overrides", () => {
      const type = unwrapResult(VerificationType.create("identity-document"));
      const req = makeVerificationRequest({
        subjectUserId: "usr_subject123",
        organizationId: "org_target456",
        type,
      });
      expect(req.subjectUserId).toBe("usr_subject123");
      expect(req.organizationId).toBe("org_target456");
      expect(req.type.value).toBe("identity-document");

      const req2 = makeVerificationRequest({ type: "identity-document" });
      expect(req2.type.value).toBe("identity-document");
    });
  });
});
