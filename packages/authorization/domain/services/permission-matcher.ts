import { Result } from "@verixa/shared-kernel";

import { Permission } from "../value-objects/permission.js";

/**
 * Matches granted permissions against a required one.
 *
 * 1. Exact: `users:read` satisfies `users:read`.
 * 2. Global wildcard: `*:*` satisfies anything; only system roles may be granted it.
 * 3. `resource:*` matches any action on that resource; `*:action` matches that action on any
 *    resource.
 * 4. Boundaries hold: `users:*` does not match `orgs:read` or `user_profiles:read`.
 */
export class PermissionMatcher {
  /**
   * Evaluates whether a granted permission satisfies a required permission.
   *
   * @param granted The permission granted to the role/user.
   * @param required The permission required by the operation or route.
   */
  static matches(granted: Permission | string, required: Permission | string): boolean {
    const grantedRes =
      typeof granted === "string" ? Permission.create(granted) : Result.ok(granted);
    const requiredRes =
      typeof required === "string" ? Permission.create(required) : Result.ok(required);

    if (Result.isErr(grantedRes) || Result.isErr(requiredRes)) {
      return false;
    }

    const grantedPerm = grantedRes.value;
    const requiredPerm = requiredRes.value;

    // 1. Direct value equivalence
    if (grantedPerm.value === requiredPerm.value) {
      return true;
    }

    // 2. Global wildcard (*:*) matches everything
    if (grantedPerm.resource === "*" && grantedPerm.action === "*") {
      return true;
    }

    // 3. Action wildcard within identical resource (e.g. users:* matches users:read)
    if (grantedPerm.resource === requiredPerm.resource && grantedPerm.action === "*") {
      return true;
    }

    // 4. Resource wildcard for identical action (e.g. *:read matches users:read)
    if (grantedPerm.resource === "*" && grantedPerm.action === requiredPerm.action) {
      return true;
    }

    return false;
  }

  /**
   * Helper to determine whether a permission is the reserved global wildcard `*:*`.
   */
  static isGlobalWildcard(permission: Permission | string): boolean {
    const permRes =
      typeof permission === "string" ? Permission.create(permission) : Result.ok(permission);
    if (Result.isErr(permRes)) {
      return false;
    }
    const perm = permRes.value;
    return perm.resource === "*" && perm.action === "*";
  }
}
