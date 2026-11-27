import type { PrismaClient } from "@verixa/database";
import { createId } from "@verixa/shared-kernel";

import type { RoleRepository } from "../../application/ports/role-repository.js";
import { Role, type RoleId } from "../../domain/entities/role.js";
import { SystemRoleImmutableError } from "../../domain/errors/system-role-immutable-error.js";

import { mapPrismaError } from "./error-mapper.js";

/**
 * Selection for every read: the role's columns plus the keys of its permissions, reached through
 * the explicit `role_permissions` join model.
 */
const ROLE_WITH_PERMISSIONS = {
  permissions: { include: { permission: { select: { key: true } } } },
} as const;

interface RoleRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly isSystemRole: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly permissions: readonly { readonly permission: { readonly key: string } }[];
}

/** Rebuilds the aggregate from a row. Storage is trusted, so validation is skipped. */
function toDomain(row: RoleRow): Role {
  return Role.reconstitute({
    id: row.id as RoleId,
    name: row.name,
    description: row.description ?? undefined,
    isSystemRole: row.isSystemRole,
    permissions: new Set(row.permissions.map((p) => p.permission.key)),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export class PrismaRoleRepository implements RoleRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Upserts the role and replaces its permission rows to match the aggregate. The delete and insert
   * run in one transaction so a reader never sees the role with no permissions. Keys with no row in
   * the seeded `permissions` catalog are skipped, so a typo cannot create a permission.
   */
  async save(role: Role): Promise<void> {
    try {
      const keys = Array.from(role.permissions);

      await this.prisma.$transaction(async (tx) => {
        await tx.role.upsert({
          where: { id: role.id },
          create: {
            id: role.id,
            name: role.name,
            description: role.description ?? null,
            isSystemRole: role.isSystemRole,
            createdAt: role.createdAt,
            updatedAt: role.updatedAt,
          },
          update: {
            name: role.name,
            description: role.description ?? null,
            isSystemRole: role.isSystemRole,
            updatedAt: role.updatedAt,
          },
        });

        for (const key of keys) {
          await tx.permission.upsert({
            where: { key },
            create: {
              id: createId<"PermissionId">(),
              key,
              createdAt: new Date(),
            },
            update: {},
          });
        }

        const known =
          keys.length === 0
            ? []
            : await tx.permission.findMany({
                where: { key: { in: keys } },
                select: { id: true },
              });

        await tx.rolePermission.deleteMany({ where: { roleId: role.id } });
        if (known.length > 0) {
          await tx.rolePermission.createMany({
            data: known.map((p) => ({ roleId: role.id, permissionId: p.id })),
          });
        }
      });
    } catch (error) {
      return mapPrismaError(error, "Role");
    }
  }

  async findById(id: RoleId): Promise<Role | undefined> {
    try {
      const row = await this.prisma.role.findUnique({
        where: { id },
        include: ROLE_WITH_PERMISSIONS,
      });
      return row === null ? undefined : toDomain(row);
    } catch (error) {
      return mapPrismaError(error, "Role");
    }
  }

  /** Names are unique across the deployment: roles are global, not per-tenant. */
  async findByName(name: string): Promise<Role | undefined> {
    try {
      const row = await this.prisma.role.findUnique({
        where: { name },
        include: ROLE_WITH_PERMISSIONS,
      });
      return row === null ? undefined : toDomain(row);
    } catch (error) {
      return mapPrismaError(error, "Role");
    }
  }

  async findAll(): Promise<Role[]> {
    try {
      const rows = await this.prisma.role.findMany({
        orderBy: { name: "asc" },
        include: ROLE_WITH_PERMISSIONS,
      });
      return rows.map(toDomain);
    } catch (error) {
      return mapPrismaError(error, "Role");
    }
  }

  /**
   * Deletes a role, refusing a system role.
   *
   * The refusal is checked here rather than left to the database: a system role
   * is what a locked-out operator recovers through, and losing one is not
   * something a later migration can undo. Deleting a role that does not exist
   * is a silent no-op, so a retried delete does not fail.
   */
  async delete(id: RoleId): Promise<void> {
    try {
      const existing = await this.prisma.role.findUnique({
        where: { id },
        select: { name: true, isSystemRole: true },
      });
      if (existing === null) return;

      if (existing.isSystemRole) {
        throw new SystemRoleImmutableError(id, existing.name, "delete");
      }

      await this.prisma.role.delete({ where: { id } });
    } catch (error) {
      if (error instanceof SystemRoleImmutableError) throw error;
      return mapPrismaError(error, "Role");
    }
  }
}
