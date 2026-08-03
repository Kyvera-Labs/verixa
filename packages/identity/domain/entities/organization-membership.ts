import { ConflictError, createId, type Id, Result } from "@verixa/shared-kernel";

import type { OrganizationId } from "./organization.js";
import type { UserId } from "./user.js";

export type OrganizationMembershipId = Id<"OrganizationMembershipId">;

export type MembershipStatus = "active" | "revoked";

interface OrganizationMembershipProps {
  readonly id: OrganizationMembershipId;
  readonly userId: UserId;
  readonly organizationId: OrganizationId;
  readonly status: MembershipStatus;
  readonly joinedAt: Date;
}

/**
 * A join entity linking a {@link UserId} to an {@link OrganizationId} —
 * modeled as a first-class domain concept (with its own identity, status,
 * and lifecycle) rather than a bare foreign-key pair, because membership
 * itself has domain meaning (it can be revoked, it has a joined-at date)
 * that a plain join table can't express. Role assignment is a separate
 * concern, added in Phase 07.
 */
export class OrganizationMembership {
  readonly id: OrganizationMembershipId;
  readonly userId: UserId;
  readonly organizationId: OrganizationId;
  readonly status: MembershipStatus;
  readonly joinedAt: Date;

  private constructor(props: OrganizationMembershipProps) {
    this.id = props.id;
    this.userId = props.userId;
    this.organizationId = props.organizationId;
    this.status = props.status;
    this.joinedAt = props.joinedAt;
  }

  /**
   * Creates a new active membership for `userId` in `organizationId`.
   * `existingMemberships` should be every membership currently known for
   * that user+organization pair (until Phase 03, callers pass this in
   * directly; once a repository exists, it will supply this list) — a
   * duplicate *active* membership is rejected, but a revoked one doesn't
   * block rejoining.
   */
  static create(params: {
    userId: UserId;
    organizationId: OrganizationId;
    existingMemberships?: readonly OrganizationMembership[];
  }): Result<OrganizationMembership, ConflictError> {
    const hasActiveDuplicate = (params.existingMemberships ?? []).some(
      (membership) =>
        membership.userId === params.userId &&
        membership.organizationId === params.organizationId &&
        membership.status === "active",
    );

    if (hasActiveDuplicate) {
      return Result.err(
        new ConflictError("User already has an active membership in this organization."),
      );
    }

    return Result.ok(
      new OrganizationMembership({
        id: createId<"OrganizationMembershipId">(),
        userId: params.userId,
        organizationId: params.organizationId,
        status: "active",
        joinedAt: new Date(),
      }),
    );
  }

  /** Rebuilds an `OrganizationMembership` from already-trusted data (e.g. a database row). */
  static reconstitute(props: OrganizationMembershipProps): OrganizationMembership {
    return new OrganizationMembership(props);
  }

  /** Revokes an active membership. Revoking an already-revoked membership is a no-op that returns the same state, not an error — it's idempotent by design. */
  revoke(): OrganizationMembership {
    if (this.status === "revoked") {
      return this;
    }
    return new OrganizationMembership({ ...this, status: "revoked" });
  }
}
