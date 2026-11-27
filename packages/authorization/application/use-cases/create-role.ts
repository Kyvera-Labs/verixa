import { ConflictError, Result, ValidationError } from "@verixa/shared-kernel";

import { Role } from "../../domain/entities/role.js";
import { PermissionMatcher } from "../../domain/services/permission-matcher.js";
import type { Permission } from "../../domain/value-objects/permission.js";
import type { RoleRepository } from "../ports/role-repository.js";

export interface CreateRoleCommand {
  readonly name: string;
  readonly description?: string | undefined;
  readonly isSystemRole?: boolean | undefined;
  readonly permissions?: Iterable<Permission | string> | undefined;
}

export type CreateRoleError = ValidationError | ConflictError;

/**
 * Creates a role: validates input, enforces a globally unique name, and persists the aggregate.
 * Roles are global; per-organization access is expressed by `UserRoleAssignment`.
 */
export class CreateRole {
  constructor(private readonly roleRepository: RoleRepository) {}

  async execute(command: CreateRoleCommand): Promise<Result<Role, CreateRoleError>> {
    const roleResult = Role.create({
      name: command.name,
      ...(command.description !== undefined ? { description: command.description } : {}),
      ...(command.isSystemRole !== undefined ? { isSystemRole: command.isSystemRole } : {}),
      ...(command.permissions !== undefined ? { permissions: command.permissions } : {}),
    });

    if (Result.isErr(roleResult)) {
      return roleResult;
    }

    const role = roleResult.value;

    if (!role.isSystemRole) {
      for (const permKey of role.permissions) {
        if (PermissionMatcher.isGlobalWildcard(permKey)) {
          return Result.err(
            new ValidationError('Global wildcard "*:*" can only be granted to system roles.', {
              permissions: ["system_role_only"],
            }),
          );
        }
      }
    }

    const existing = await this.roleRepository.findByName(role.name);
    if (existing !== undefined) {
      return Result.err(new ConflictError(`Role with name "${role.name}" already exists.`));
    }

    await this.roleRepository.save(role);

    return Result.ok(role);
  }
}
