import { DEFAULT_LOCKOUT_POLICY } from "@verixa/credentials";
import { Result, ValidationError } from "@verixa/shared-kernel";
import {
  InvalidStatusTransitionError,
  ReviewDecisionNotPermittedError,
  VerificationRequest,
} from "@verixa/verification";
import { describe, expect, it } from "vitest";

import { aCredential, anMfaMethod, aPendingInvitation, aVerificationRequest } from "./index.js";

const NOW = new Date("2026-01-15T12:00:00.000Z");

/**
 * Round-trips a request through `VerificationRequest.reconstitute`, which
 * re-checks the aggregate's cross-field invariants (decision iff terminal,
 * note iff needs_more_info, assignment only while in_review) and throws on any
 * disagreement. Asserting through it means "domain-valid" is the domain's
 * verdict, not this test's reading of individual fields.
 */
function roundTrip(request: VerificationRequest): VerificationRequest {
  return VerificationRequest.reconstitute({
    id: request.id,
    subjectUserId: request.subjectUserId,
    organizationId: request.organizationId,
    type: request.type,
    status: request.status,
    assignment: request.assignment,
    decision: request.decision,
    needsMoreInfoNote: request.needsMoreInfoNote,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  });
}

describe("testing-kit builders (Issue 419)", () => {
  describe("chained calls compose", () => {
    it("applies every .with*() call on a verification request", () => {
      const request = aVerificationRequest()
        .ofType("address")
        .forSubject("usr_subject")
        .inOrganization("org_acme")
        .inReview()
        .claimedBy("rev_alice")
        .approvedBy("rev_alice", "Documents match.")
        .build(NOW);

      expect(request.type.value).toBe("address");
      expect(request.subjectUserId).toBe("usr_subject");
      expect(request.organizationId).toBe("org_acme");
      expect(request.status.value).toBe("approved");
      expect(request.decision?.decidedBy).toBe("rev_alice");
      expect(request.decision?.note).toBe("Documents match.");
    });

    it("applies every .with*() call on an MFA method", () => {
      const method = anMfaMethod()
        .ofType("backup_codes")
        .forUser("usr_owner")
        .afterFailedAttempts(5)
        .build(NOW);

      expect(method.type).toBe("backup_codes");
      expect(method.userId).toBe("usr_owner");
      expect(method.isLockedAt(NOW)).toBe(true);
    });

    it("applies every .with*() call on an invitation", () => {
      const invitation = aPendingInvitation()
        .sentTo("new.member@example.com")
        .toOrganization("org_acme")
        .invitedBy("usr_admin")
        .accepted()
        .build(NOW);

      expect(invitation.email.value).toBe("new.member@example.com");
      expect(invitation.organizationId).toBe("org_acme");
      expect(invitation.invitedByUserId).toBe("usr_admin");
      expect(invitation.status).toBe("accepted");
    });

    it("applies every .with*() call on a credential", () => {
      const credential = aCredential()
        .forUser("usr_owner")
        .withPasswordHash("hash-0")
        .afterPasswordRotations({ depth: 5 }, "hash-1", "hash-2")
        .afterFailedLogins(2)
        .build(NOW);

      expect(credential.userId).toBe("usr_owner");
      expect(credential.passwordHash).toBe("hash-2");
      expect(credential.failedAttempts).toBe(2);
    });
  });

  describe("immutability: branching from a shared base", () => {
    it("never leaks one branch's steps into the base or a sibling branch", () => {
      const base = aVerificationRequest().inReview();
      const approved = base.claimedBy("rev_a").approvedBy("rev_a");
      const rejected = base.claimedBy("rev_b").rejectedBy("rev_b");

      expect(base.build(NOW).status.value).toBe("in_review");
      expect(approved.build(NOW).status.value).toBe("approved");
      expect(rejected.build(NOW).status.value).toBe("rejected");
    });

    it("never leaks factory-option overrides between branches", () => {
      const base = aPendingInvitation().toOrganization("org_shared");
      const toAlice = base.sentTo("alice@example.com");
      const toBob = base.sentTo("bob@example.com");

      expect(toAlice.build(NOW).email.value).toBe("alice@example.com");
      expect(toBob.build(NOW).email.value).toBe("bob@example.com");
      expect(base.build(NOW).email.value).not.toMatch(/^(alice|bob)@/);
      expect(toBob.build(NOW).organizationId).toBe("org_shared");
    });
  });

  describe("build() output passes the domain's own invariants", () => {
    it("produces verification requests that survive reconstitute's consistency checks", () => {
      const builds = [
        aVerificationRequest().build(NOW),
        aVerificationRequest().submitted().build(NOW),
        aVerificationRequest().inReview().claimedBy("rev_a").build(NOW),
        aVerificationRequest().inReview().claimedBy("rev_a").rejectedBy("rev_a").build(NOW),
        aVerificationRequest()
          .inReview()
          .claimedBy("rev_a")
          .awaitingMoreInformationFrom("rev_a", "Need a clearer photo.")
          .build(NOW),
      ];

      for (const request of builds) {
        expect(() => roundTrip(request)).not.toThrow();
      }
    });

    it("produces an accepted invitation the domain itself recognises as already accepted", () => {
      const invitation = aPendingInvitation().accepted().build(NOW);

      const again = invitation.accept(NOW);

      expect(Result.isErr(again) && again.error.fieldErrors.status).toEqual(["already_accepted"]);
    });

    it("produces a lockout whose duration is the lockout policy's, not a fixture value", () => {
      const credential = aCredential().lockedOut().build(NOW);
      const justBeforeExpiry = new Date(NOW.getTime() + DEFAULT_LOCKOUT_POLICY.baseDurationMs - 1);
      const atExpiry = new Date(NOW.getTime() + DEFAULT_LOCKOUT_POLICY.baseDurationMs);

      expect(credential.isLockedAt(justBeforeExpiry)).toBe(true);
      expect(credential.isLockedAt(atExpiry)).toBe(false);
    });

    it("produces password history the domain's reuse check actually consults", async () => {
      const credential = aCredential()
        .withPasswordHash("hash-0")
        .afterPasswordRotations({ depth: 1 }, "hash-1", "hash-2")
        .build(NOW);
      const sameHash = (plain: string, hash: string) => Promise.resolve(plain === hash);

      await expect(credential.isPasswordReused("hash-1", sameHash)).resolves.toBe(true);
      // depth 1: hash-0 was pushed out of history by the second rotation.
      await expect(credential.isPasswordReused("hash-0", sameHash)).resolves.toBe(false);
    });

    it("produces a consumed TOTP step the domain refuses to accept again", () => {
      const method = anMfaMethod().withConsumedTotpStep(42).build(NOW);

      expect(() => method.recordTotpUse(42, NOW)).toThrow(/Replay detected/);
      expect(() => method.recordTotpUse(43, NOW)).not.toThrow();
    });
  });

  describe("impossible combinations fail loudly at build() with the domain's error", () => {
    it("refuses a decision on a request that never reached review", () => {
      const builder = aVerificationRequest().approvedBy("rev_a");

      expect(() => builder.build(NOW)).toThrow(InvalidStatusTransitionError);
    });

    it("refuses a decision by a reviewer who holds no claim", () => {
      const builder = aVerificationRequest().inReview().approvedBy("rev_a");

      expect(() => builder.build(NOW)).toThrow(ReviewDecisionNotPermittedError);
    });

    it("refuses accepting an expired invitation", () => {
      const builder = aPendingInvitation().expired().accepted();

      expect(() => builder.build(NOW)).toThrow(ValidationError);
      expect(() => builder.build(NOW)).toThrow("This invitation has expired.");
    });

    it("refuses accepting a revoked invitation", () => {
      expect(() => aPendingInvitation().revoked().accepted().build(NOW)).toThrow(
        "This invitation has been revoked.",
      );
    });

    it("refuses using a disabled MFA method", () => {
      expect(() => anMfaMethod().disabled().recentlyUsed().build(NOW)).toThrow(
        "Only active methods can be used for verification.",
      );
    });

    it("defers the failure to build(), so an impossible chain can still be declared", () => {
      expect(() => aVerificationRequest().approvedBy("rev_a")).not.toThrow();
    });
  });

  describe("every build() returns a fresh instance", () => {
    it("returns distinct aggregates with distinct identities", () => {
      const builder = aVerificationRequest().inReview();

      const first = builder.build(NOW);
      const second = builder.build(NOW);

      expect(first).not.toBe(second);
      expect(first.id).not.toBe(second.id);
    });

    it("isolates builds of a self-mutating aggregate (MfaMethod mutates in place)", () => {
      const builder = anMfaMethod();
      const first = builder.build(NOW);

      first.disable(NOW);
      const second = builder.build(NOW);

      expect(first).not.toBe(second);
      expect(second.status).toBe("active");
    });
  });
});

describe("builder options covered by the coverage ratchet", () => {
  it("forDeletedUser replaces the hash with an unverifiable sentinel and clears lockout", () => {
    const credential = aCredential().lockedOut().forDeletedUser().build(NOW);

    expect(credential.passwordHash).toBe("[DELETED]");
    expect(credential.failedAttempts).toBe(0);
    expect(credential.lockedUntil).toBeUndefined();
  });

  it("expiringIn sets the invitation's expiry relative to build time", () => {
    const ttlMs = 60 * 60 * 1000;
    const invitation = aPendingInvitation().expiringIn(ttlMs).build(NOW);

    expect(invitation.expiresAt.getTime()).toBe(NOW.getTime() + ttlMs);
  });

  it("pendingEnrollment leaves the method pending, with or without an explicit secret", () => {
    const withSecret = anMfaMethod().pendingEnrollment("JBSWY3DPEHPK3PXP").build(NOW);
    const withDefault = anMfaMethod().pendingEnrollment().build(NOW);

    expect(withSecret.status).toBe("pending");
    expect(withSecret.secret).toBe("JBSWY3DPEHPK3PXP");
    expect(withDefault.status).toBe("pending");
  });

  it("ofType sets the MFA factor kind", () => {
    const method = anMfaMethod().ofType("webauthn").build(NOW);

    expect(method.type).toBe("webauthn");
  });
});
