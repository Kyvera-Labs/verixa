import { createId, type Id, Result, ValidationError } from "@verixa/shared-kernel";

export type OrganizationMembershipId = Id<"OrganizationMembershipId">;
export type OrganizationId = Id<"OrganizationId">;
export type UserId = Id<"UserId">;
export type OrganizationRole = "owner" | "admin" | "member";

export interface OrganizationMembershipProps {
  readonly id: OrganizationMembershipId;
  readonly organizationId: OrganizationId;
  readonly userId: UserId;
  readonly role: OrganizationRole;
  readonly active: boolean;
}

const canManage = (role: OrganizationRole): boolean => role === "owner" || role === "admin";

export class OrganizationMembership {
  readonly id: OrganizationMembershipId;
  readonly organizationId: OrganizationId;
  readonly userId: UserId;
  readonly role: OrganizationRole;
  readonly active: boolean;

  private constructor(private readonly props: OrganizationMembershipProps) {
    this.id = props.id;
    this.organizationId = props.organizationId;
    this.userId = props.userId;
    this.role = props.role;
    this.active = props.active;
  }

  static create(
    params: Omit<OrganizationMembershipProps, "id" | "active">,
  ): OrganizationMembership {
    return new OrganizationMembership({
      ...params,
      id: createId<"OrganizationMembershipId">(),
      active: true,
    });
  }

  static reconstitute(props: OrganizationMembershipProps): OrganizationMembership {
    return new OrganizationMembership(props);
  }

  changeRole(
    actorRole: OrganizationRole,
    role: OrganizationRole,
    activeOwnerCount: number,
  ): Result<OrganizationMembership, ValidationError> {
    if (!canManage(actorRole) || (role === "owner" && actorRole !== "owner")) {
      return Result.err(new ValidationError("Actor is not authorized to change membership roles."));
    }
    if (this.role === "owner" && role !== "owner" && activeOwnerCount <= 1) {
      return Result.err(new ValidationError("The last organization owner cannot be demoted."));
    }
    return Result.ok(new OrganizationMembership({ ...this.props, role }));
  }

  remove(
    actorRole: OrganizationRole,
    activeOwnerCount: number,
  ): Result<OrganizationMembership, ValidationError> {
    if (!canManage(actorRole))
      return Result.err(new ValidationError("Actor is not authorized to remove members."));
    if (this.role === "owner" && activeOwnerCount <= 1) {
      return Result.err(new ValidationError("The last organization owner cannot be removed."));
    }
    return Result.ok(new OrganizationMembership({ ...this.props, active: false }));
  }
}
