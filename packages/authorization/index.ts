export type { PermissionRepository } from "./application/ports/permission-repository.js";
export type { RoleRepository } from "./application/ports/role-repository.js";
export type {
  FindUserRoleAssignmentsOptions,
  UserRoleAssignmentRepository,
} from "./application/ports/user-role-assignment-repository.js";
export {
  Role,
  type CreateRoleParams,
  type OrgId,
  type RoleId,
  type RoleProps,
} from "./domain/entities/role.js";
export {
  UserRoleAssignment,
  type UserRoleAssignmentId,
  type UserId,
} from "./domain/entities/user-role-assignment.js";
export {
  SystemRoleImmutableError,
  type SystemRoleAction,
} from "./domain/errors/system-role-immutable-error.js";
export { Permission } from "./domain/value-objects/permission.js";
export { InMemoryPermissionRepository } from "./infrastructure/fakes/in-memory-permission-repository.js";
export { InMemoryRoleRepository } from "./infrastructure/fakes/in-memory-role-repository.js";
export { InMemoryUserRoleAssignmentRepository } from "./infrastructure/fakes/in-memory-user-role-assignment-repository.js";
export { permissionRepositoryContract } from "./infrastructure/testing/contracts/permission-repository.contract.js";
export { roleRepositoryContract } from "./infrastructure/testing/contracts/role-repository.contract.js";
export { userRoleAssignmentRepositoryContract } from "./infrastructure/testing/contracts/user-role-assignment-repository.contract.js";
