import type {
  OrgId,
  UserId,
  UserRoleAssignment,
  UserRoleAssignmentId,
} from "../../domain/entities/user-role-assignment.js";

export interface FindUserRoleAssignmentsOptions {
  /**
   * If true, expired assignments are included in the results.
   * Defaults to `false` (safe-by-default: expired assignments are excluded).
   */
  readonly includeExpired?: boolean;

  /**
   * Reference timestamp to evaluate expiration against.
   * Defaults to the current time (`new Date()`).
   */
  readonly now?: Date;
}

/**
 * Persistence port for `UserRoleAssignment`, modelled separately from users and roles to support
 * organization scoping and temporary elevation.
 *
 * - `save` is an idempotent upsert.
 * - `findById` returns the assignment, or `undefined`.
 * - `findByUser` returns assignments across all scopes.
 * - `findByUserAndOrg` returns assignments for one organization, or global ones when `orgId` is
 *   `null`.
 * - Both finders exclude expired assignments unless `{ includeExpired: true }` is passed.
 * - `revoke` removes an assignment and is a no-op if it does not exist.
 */
export interface UserRoleAssignmentRepository {
  findById(id: UserRoleAssignmentId): Promise<UserRoleAssignment | undefined>;
  findByUser(
    userId: UserId,
    options?: FindUserRoleAssignmentsOptions,
  ): Promise<UserRoleAssignment[]>;
  findByUserAndOrg(
    userId: UserId,
    orgId: OrgId | null,
    options?: FindUserRoleAssignmentsOptions,
  ): Promise<UserRoleAssignment[]>;
  save(assignment: UserRoleAssignment): Promise<void>;
  revoke(id: UserRoleAssignmentId): Promise<void>;
}
