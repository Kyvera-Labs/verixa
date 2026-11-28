import type { User, UserId } from "../../domain/entities/user.js";
import type { Email } from "../../domain/value-objects/email.js";

/**
 * Persistence port for `User` (see docs/guides/domain-modeling.md).
 *
 * - `findById` and `findByEmail` return `undefined` when no user matches, and exclude soft-deleted
 *   users.
 * - `findByIdIncludingDeleted` is the explicit admin and audit lookup; a separate method rather
 *   than a flag, so the intent is visible at the call site.
 * - `existsByEmail` includes deleted users, because the unique index does; ignoring them would turn
 *   a clear conflict into a constraint violation at insert. Adapters can implement it with a cheap
 *   existence query.
 * - `save` is an idempotent upsert.
 */
export interface UserRepository {
  findById(id: UserId): Promise<User | undefined>;
  findManyByIds(ids: readonly UserId[]): Promise<User[]>;
  findByEmail(email: Email): Promise<User | undefined>;
  findByIdIncludingDeleted(id: UserId): Promise<User | undefined>;
  save(user: User): Promise<void>;
  existsByEmail(email: Email): Promise<boolean>;
}
