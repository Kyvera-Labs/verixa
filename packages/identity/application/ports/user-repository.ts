import type { User, UserId } from "../../domain/entities/user.js";
import type { Email } from "../../domain/value-objects/email.js";

/**
 * The persistence contract the application layer needs for `User` — the
 * **port** half of ports & adapters (hexagonal architecture). No Prisma, SQL,
 * or any other implementation detail appears here; the concrete adapter
 * (Phase 03, Prisma-backed) implements this interface without this package
 * ever depending on it. See `docs/guides/domain-modeling.md`.
 *
 * Method contracts:
 * - `findById`/`findByEmail` return `undefined` when no matching user
 *   exists — a missing user is an expected, common outcome (e.g. checking
 *   whether an email is already taken), not an error condition, so it isn't
 *   modeled as a `Result` error the way a genuinely-unexpected failure would
 *   be.
 * - `save` is an idempotent upsert: it persists whatever `User` state it's
 *   given, whether that `User` is new or previously existed. Callers don't
 *   distinguish "create" from "update" — the aggregate's own state is the
 *   only thing that matters.
 *
 * ## Soft-delete (Issue 054)
 *
 * Deleted users are never removed, only marked. The read methods therefore
 * split into two kinds, and the split is deliberate rather than an options
 * flag:
 *
 * - `findById`/`findByEmail` **exclude** soft-deleted users. This is the
 *   default because it is what nearly every caller means, and because the
 *   safe failure is to not find someone rather than to resurrect them.
 * - `findByIdIncludingDeleted` is the explicit admin/audit escape hatch. A
 *   separate method rather than `findById(id, { includeDeleted })` so the
 *   intent is visible at the call site and greppable in review — a boolean
 *   parameter can be passed a variable that is `true` by accident, a method
 *   name cannot.
 *
 * - `existsByEmail` **includes** deleted users, unlike the finders. That is
 *   not an inconsistency: it exists to answer "can this email be registered",
 *   and the unique index covers deleted rows too. If it ignored them,
 *   registration would pass its own check and then fail on a constraint
 *   violation at insert — a confusing 500 instead of a clear conflict.
 *
 * - `existsByEmail` is a separate method from `findByEmail`, not just sugar
 *   for `(await findByEmail(email)) !== undefined`, because the common
 *   caller (uniqueness validation before registering a new user) only needs
 *   a yes/no answer — a real adapter can satisfy `existsByEmail` with a
 *   cheaper query (e.g. `SELECT 1 ... LIMIT 1` / an index-only existence
 *   check) than reconstructing and returning a full `User` aggregate.
 */
export interface UserRepository {
  findById(id: UserId): Promise<User | undefined>;
  findManyByIds(ids: readonly UserId[]): Promise<User[]>;
  findByEmail(email: Email): Promise<User | undefined>;
  findByIdIncludingDeleted(id: UserId): Promise<User | undefined>;
  save(user: User): Promise<void>;
  existsByEmail(email: Email): Promise<boolean>;
}
