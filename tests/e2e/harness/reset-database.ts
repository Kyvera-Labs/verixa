import type { PrismaClient } from "@verixa/database";

/**
 * Cleanly truncates or deletes all data across all tables in reverse dependency order.
 *
 * Foreign-key constraints in Postgres mean deletion order is strictly enforced:
 * child rows (such as RefreshToken, Session, Credential, Tokens, Memberships) must
 * be removed before their parent entities (such as User, Organization, Role).
 *
 * This function provides deterministic database reset per test file or test case,
 * preventing cross-test pollution and ordering-dependent flakiness.
 */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  // Clear tables in exact reverse foreign-key dependency order
  await prisma.refreshToken.deleteMany({});
  await prisma.session.deleteMany({});
  await prisma.verificationRequest.deleteMany({});
  await prisma.emailVerificationToken.deleteMany({});
  await prisma.passwordResetToken.deleteMany({});
  await prisma.credential.deleteMany({});
  await prisma.mfaMethod.deleteMany({});
  await prisma.userRoleAssignment.deleteMany({});
  await prisma.rolePermission.deleteMany({});
  await prisma.permission.deleteMany({});
  await prisma.role.deleteMany({});
  await prisma.anchorRecord.deleteMany({});
  await prisma.auditLogEntry.deleteMany({});
  await prisma.invitation.deleteMany({});
  await prisma.organizationMembership.deleteMany({});
  await prisma.organization.deleteMany({});
  await prisma.policy.deleteMany({});
  await prisma.user.deleteMany({});
}

/**
 * Runs an action within an isolated test boundary that guarantees database reset
 * both before execution and in a `finally` block, ensuring clean teardown even
 * when an assertion fails or an unexpected exception is thrown mid-way.
 */
export async function withDatabaseReset<T>(
  prisma: PrismaClient,
  action: () => Promise<T>,
): Promise<T> {
  await resetDatabase(prisma);
  try {
    return await action();
  } finally {
    await resetDatabase(prisma);
  }
}
