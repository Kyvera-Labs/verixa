import type { Permission } from "../../domain/value-objects/permission.js";

/**
 * Persistence port for the permission catalog: the registered permissions, independent of which
 * roles use them.
 *
 * - `save` registers a permission and throws {@link ConflictError} if the normalized key already
 *   exists.
 * - `findByKey` is case-insensitive and trims whitespace; returns `undefined` when not registered.
 * - `findAll` returns every registered permission, or an empty array.
 */
export interface PermissionRepository {
  save(permission: Permission): Promise<void>;
  findByKey(key: string): Promise<Permission | undefined>;
  findAll(): Promise<Permission[]>;
}
