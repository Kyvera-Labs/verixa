import { randomUUID } from "node:crypto";

import type { PrismaClient } from "@verixa/database";

export interface SeedUserInput {
  readonly id?: string;
  readonly email?: string;
  readonly displayName?: string;
  readonly status?: "pending" | "active" | "suspended" | "deleted";
}

export interface SeedCredentialInput {
  readonly id?: string;
  readonly userId: string;
  readonly passwordHash?: string;
  readonly failedAttempts?: number;
  readonly lockedUntil?: Date | null;
}

export interface SeedRoleInput {
  readonly id?: string;
  readonly name: string;
  readonly description?: string;
  readonly isSystemRole?: boolean;
}

export interface SeedOrganizationInput {
  readonly id?: string;
  readonly name?: string;
  readonly ownerId: string;
}

export interface SeedAssignmentInput {
  readonly id?: string;
  readonly userId: string;
  readonly roleId: string;
  readonly organizationId: string;
  readonly assignedBy?: string | null;
  readonly expiresAt?: Date | null;
}

/** Standard pre-hashed Argon2 password for tests: "correct horse battery staple" */
export const DEFAULT_TEST_PASSWORD = "correct horse battery staple";
export const DEFAULT_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,t=3,p=4$someDeterministicSalt$someDeterministicHashValueForTestingOnly";

/** Seeds a User entity into Postgres with deterministic defaults. */
export async function seedUser(prisma: PrismaClient, overrides: SeedUserInput = {}) {
  const id = overrides.id ?? randomUUID();
  const email = overrides.email ?? `user-${id.slice(0, 8)}@example.com`;
  const displayName = overrides.displayName ?? `Test User ${id.slice(0, 4)}`;
  const status = overrides.status ?? "active";

  const user = await prisma.user.create({
    data: {
      id,
      email: email.toLowerCase(),
      displayName,
      status,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });

  return user;
}

/** Seeds a Credential entity linked to a valid User. */
export async function seedCredential(prisma: PrismaClient, input: SeedCredentialInput) {
  const id = input.id ?? randomUUID();
  const passwordHash = input.passwordHash ?? DEFAULT_PASSWORD_HASH;

  return await prisma.credential.create({
    data: {
      id,
      userId: input.userId,
      passwordHash,
      failedAttempts: input.failedAttempts ?? 0,
      lockedUntil: input.lockedUntil ?? null,
      passwordHistory: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
}

/** Seeds an Organization entity owned by an existing User. */
export async function seedOrganization(prisma: PrismaClient, input: SeedOrganizationInput) {
  const id = input.id ?? randomUUID();
  const name = input.name ?? `Test Org ${id.slice(0, 4)}`;
  const slug = `org-${id.slice(0, 8)}`.toLowerCase();

  return await prisma.organization.create({
    data: {
      id,
      name,
      slug,
      status: "active",
      ownerId: input.ownerId,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
}

/** Seeds a Role with optional permissions. */
export async function seedRole(prisma: PrismaClient, input: SeedRoleInput) {
  const id = input.id ?? randomUUID();

  return await prisma.role.create({
    data: {
      id,
      name: input.name,
      description: input.description ?? `Description for ${input.name}`,
      isSystemRole: input.isSystemRole ?? false,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
}

/** Seeds a Permission key. */
export async function seedPermission(
  prisma: PrismaClient,
  key: string,
  description = `Permission ${key}`,
) {
  const id = randomUUID();
  return await prisma.permission.upsert({
    where: { key },
    create: { id, key, description, createdAt: new Date() },
    update: {},
  });
}

/** Links a Permission to a Role via the explicit join table. */
export async function grantPermissionToRole(
  prisma: PrismaClient,
  roleId: string,
  permissionKey: string,
) {
  const permission = await seedPermission(prisma, permissionKey);
  return await prisma.rolePermission.upsert({
    where: {
      roleId_permissionId: {
        roleId,
        permissionId: permission.id,
      },
    },
    create: {
      roleId,
      permissionId: permission.id,
    },
    update: {},
  });
}

/** Assigns a Role to a User within an Organization. */
export async function seedUserRoleAssignment(prisma: PrismaClient, input: SeedAssignmentInput) {
  const id = input.id ?? randomUUID();
  return await prisma.userRoleAssignment.create({
    data: {
      id,
      userId: input.userId,
      roleId: input.roleId,
      organizationId: input.organizationId,
      assignedBy: input.assignedBy ?? null,
      assignedAt: new Date(),
      expiresAt: input.expiresAt ?? null,
    },
  });
}

/** Seeds a user along with their authentication credential in a single step. */
export async function seedCompleteUser(
  prisma: PrismaClient,
  overrides: SeedUserInput & { password?: string } = {},
) {
  const user = await seedUser(prisma, overrides);
  await seedCredential(prisma, {
    userId: user.id,
    ...(overrides.password ? {} : { passwordHash: DEFAULT_PASSWORD_HASH }),
  });
  return {
    user,
    password: overrides.password ?? DEFAULT_TEST_PASSWORD,
  };
}
