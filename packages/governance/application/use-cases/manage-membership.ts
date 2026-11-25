import { Result, ValidationError } from "@verixa/shared-kernel";

import {
  OrganizationMembership,
  type OrganizationId,
  type OrganizationRole,
  type UserId,
} from "../../domain/organization-membership.js";

export interface MembershipRepository {
  find(organizationId: OrganizationId, userId: UserId): Promise<OrganizationMembership | null>;
  countOwners(organizationId: OrganizationId): Promise<number>;
  save(membership: OrganizationMembership): Promise<void>;
}

export class AddMember {
  constructor(private readonly repository: MembershipRepository) {}
  async execute(input: {
    organizationId: OrganizationId;
    userId: UserId;
    role: OrganizationRole;
    actorRole: OrganizationRole;
  }): Promise<Result<OrganizationMembership, ValidationError>> {
    if (input.actorRole !== "owner" && input.actorRole !== "admin")
      return Result.err(new ValidationError("Actor is not authorized to add members."));
    // Same rule as changeRole: only an owner may grant the owner role. Without
    // this an admin could add a second account as owner and then remove the
    // real owner.
    if (input.role === "owner" && input.actorRole !== "owner")
      return Result.err(new ValidationError("Only an owner may grant the owner role."));
    const membership = OrganizationMembership.create({
      organizationId: input.organizationId,
      userId: input.userId,
      role: input.role,
    });
    await this.repository.save(membership);
    return Result.ok(membership);
  }
}

export class RemoveMember {
  constructor(private readonly repository: MembershipRepository) {}
  async execute(input: {
    organizationId: OrganizationId;
    userId: UserId;
    actorRole: OrganizationRole;
  }): Promise<Result<OrganizationMembership, ValidationError>> {
    const membership = await this.repository.find(input.organizationId, input.userId);
    if (!membership) return Result.err(new ValidationError("Membership was not found."));
    const result = membership.remove(
      input.actorRole,
      await this.repository.countOwners(input.organizationId),
    );
    if (Result.isOk(result)) await this.repository.save(result.value);
    return result;
  }
}

export class ChangeMemberRole {
  constructor(private readonly repository: MembershipRepository) {}
  async execute(input: {
    organizationId: OrganizationId;
    userId: UserId;
    role: OrganizationRole;
    actorRole: OrganizationRole;
  }): Promise<Result<OrganizationMembership, ValidationError>> {
    const membership = await this.repository.find(input.organizationId, input.userId);
    if (!membership) return Result.err(new ValidationError("Membership was not found."));
    const result = membership.changeRole(
      input.actorRole,
      input.role,
      await this.repository.countOwners(input.organizationId),
    );
    if (Result.isOk(result)) await this.repository.save(result.value);
    return result;
  }
}
