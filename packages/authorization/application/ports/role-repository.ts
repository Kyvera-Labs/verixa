import type { Role, RoleId } from "../../domain/entities/role.js";

/**
 * Persistence port for `Role`.
 *
 * - `findById` returns the role, or `undefined` when missing.
 * - `findByName` looks up a role by its deployment-wide unique name. Roles are global, not per
 *   organization.
 * - `findAll` returns every role.
 * - `save` is an idempotent upsert of the aggregate's state.
 * - `delete` is a no-op for a missing role and throws {@link SystemRoleImmutableError} for a system
 *   role.
 */
export interface RoleRepository {
  findById(id: RoleId): Promise<Role | undefined>;
  findByName(name: string): Promise<Role | undefined>;
  findAll(): Promise<Role[]>;
  save(role: Role): Promise<void>;
  delete(id: RoleId): Promise<void>;
}
