import { PrismaClient } from "@verixa/database";
import {
  CreateOrganization,
  InviteUserToOrganization,
  PrismaInvitationRepository,
  PrismaUnitOfWork,
  PrismaUserRepository,
  ReactivateUser,
  RegisterUser,
  SuspendUser,
  UpdateUserProfile,
} from "@verixa/identity";

/**
 * The composition root: the one place in the system allowed to know which
 * concrete implementations exist.
 *
 * Everything else depends on interfaces. `RegisterUser` knows it needs *a*
 * `UserRepository`; it has no idea one is backed by Prisma. That's what makes
 * the whole application layer testable without a database — and it only holds
 * because the knowledge of "which implementation" is concentrated here rather
 * than scattered across the modules that use them.
 *
 * The rule to preserve: **nothing outside this file imports a `Prisma*`
 * class.** The moment a route handler constructs its own repository, the
 * dependency inversion is gone and that handler can no longer be tested
 * without a database. Wiring is deliberately boring and explicit for the same
 * reason — a DI container would hide these edges behind runtime resolution,
 * where a missing dependency becomes a runtime failure instead of a compile
 * error. At this size, explicit construction costs a few lines and buys
 * complete type safety.
 */

/** Every use case the application exposes, fully wired. */
export interface IdentityUseCases {
  readonly registerUser: RegisterUser;
  readonly updateUserProfile: UpdateUserProfile;
  readonly suspendUser: SuspendUser;
  readonly reactivateUser: ReactivateUser;
  readonly createOrganization: CreateOrganization;
  readonly inviteUserToOrganization: InviteUserToOrganization;
}

export interface Container {
  readonly prisma: PrismaClient;
  readonly identity: IdentityUseCases;
  /** Releases the database connection. Call on shutdown. */
  readonly dispose: () => Promise<void>;
}

/**
 * Builds the object graph.
 *
 * Takes an optional `PrismaClient` so tests can inject one pointed at a
 * throwaway database. Production passes nothing and gets a client configured
 * from `DATABASE_URL`.
 */
export function buildContainer(prismaClient?: PrismaClient): Container {
  const prisma = prismaClient ?? new PrismaClient();

  const users = new PrismaUserRepository(prisma);
  const invitations = new PrismaInvitationRepository(prisma);
  const unitOfWork = new PrismaUnitOfWork(prisma);

  // PrismaOrganizationRepository and PrismaOrganizationMembershipRepository
  // aren't constructed here: the only use case that touches them
  // (CreateOrganization) reaches them through the unit of work, since its two
  // writes must commit together. Phase 12's read-only routes will need them
  // directly, and that's when they get wired — building them now would mean
  // an unused object graph pretending to be used.

  return {
    prisma,
    identity: {
      registerUser: new RegisterUser(users),
      updateUserProfile: new UpdateUserProfile(users),
      suspendUser: new SuspendUser(users),
      reactivateUser: new ReactivateUser(users),
      // Takes the unit of work rather than the two repositories: it writes an
      // organization and a membership, and those must commit together.
      createOrganization: new CreateOrganization(unitOfWork),
      inviteUserToOrganization: new InviteUserToOrganization(invitations),
    },
    dispose: async () => {
      await prisma.$disconnect();
    },
  };
}
