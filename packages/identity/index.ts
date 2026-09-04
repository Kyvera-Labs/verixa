// Curated public surface of @verixa/identity. Nothing outside this package
// should import from a deep path (`@verixa/identity/domain/...`,
// `@verixa/identity/application/...`) — see docs/guides/domain-modeling.md
// ("Package encapsulation") for why, and eslint.config.mjs's
// `no-restricted-imports` rule, which enforces it.

// Domain: entities
export type {
  OrganizationMembershipId,
  MembershipStatus,
} from "./domain/entities/organization-membership.js";
export { OrganizationMembership } from "./domain/entities/organization-membership.js";
export type { OrganizationId, OrganizationStatus } from "./domain/entities/organization.js";
export { Organization } from "./domain/entities/organization.js";
export type { UserId, UserStatus } from "./domain/entities/user.js";
export { User } from "./domain/entities/user.js";
export type { InvitationId, InvitationStatus } from "./domain/entities/invitation.js";
export { Invitation } from "./domain/entities/invitation.js";

// Domain: value objects
export { DisplayName } from "./domain/value-objects/display-name.js";
export { Email } from "./domain/value-objects/email.js";
export { PersonName } from "./domain/value-objects/person-name.js";

// Domain: events
export { OrganizationInvitationCreated } from "./domain/events/organization-invitation-created.js";
export { UserProfileUpdated } from "./domain/events/user-profile-updated.js";
export { UserRegistered } from "./domain/events/user-registered.js";
export { UserStatusChanged } from "./domain/events/user-status-changed.js";

// Application: ports (for infrastructure adapters, e.g. Phase 03's Prisma
// implementations, to implement — see docs/guides/domain-modeling.md)
export type { InvitationRepository } from "./application/ports/invitation-repository.js";
export type { OrganizationMembershipRepository } from "./application/ports/organization-membership-repository.js";
export type { OrganizationRepository } from "./application/ports/organization-repository.js";
export type { UserRepository } from "./application/ports/user-repository.js";

// Application: use cases
export type {
  CreateOrganizationCommand,
  CreateOrganizationError,
  CreateOrganizationResult,
} from "./application/use-cases/create-organization.js";
export { CreateOrganization } from "./application/use-cases/create-organization.js";
export type {
  InviteUserToOrganizationCommand,
  InviteUserToOrganizationError,
} from "./application/use-cases/invite-user-to-organization.js";
export { InviteUserToOrganization } from "./application/use-cases/invite-user-to-organization.js";
export type {
  ReactivateUserCommand,
  ReactivateUserError,
} from "./application/use-cases/reactivate-user.js";
export { ReactivateUser } from "./application/use-cases/reactivate-user.js";
export type {
  RegisterUserCommand,
  RegisterUserError,
} from "./application/use-cases/register-user.js";
export { RegisterUser } from "./application/use-cases/register-user.js";
export type { SuspendUserCommand, SuspendUserError } from "./application/use-cases/suspend-user.js";
export { SuspendUser } from "./application/use-cases/suspend-user.js";
export type {
  UpdateUserProfileCommand,
  UpdateUserProfileError,
} from "./application/use-cases/update-user-profile.js";
export { UpdateUserProfile } from "./application/use-cases/update-user-profile.js";

// Infrastructure: Prisma-backed adapters. Exported so the composition root
// (apps/api) can construct them — it is the one place allowed to know which
// concrete implementation is in use.
export { PrismaUserRepository } from "./infrastructure/persistence/prisma-user-repository.js";
export {
  PrismaOrganizationMembershipRepository,
  PrismaOrganizationRepository,
} from "./infrastructure/persistence/prisma-organization-repository.js";
export { PrismaInvitationRepository } from "./infrastructure/persistence/prisma-invitation-repository.js";
export { PrismaUnitOfWork } from "./infrastructure/persistence/prisma-unit-of-work.js";
export type { IdentityRepositories, UnitOfWork } from "./application/ports/unit-of-work.js";
export type { IssuedInvitation } from "./domain/entities/invitation.js";
export { withTenantContext } from "./infrastructure/persistence/prisma-tenant-context.js";
