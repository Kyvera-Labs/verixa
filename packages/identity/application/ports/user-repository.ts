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
 * - `existsByEmail` is a separate method from `findByEmail`, not just sugar
 *   for `(await findByEmail(email)) !== undefined`, because the common
 *   caller (uniqueness validation before registering a new user) only needs
 *   a yes/no answer — a real adapter can satisfy `existsByEmail` with a
 *   cheaper query (e.g. `SELECT 1 ... LIMIT 1` / an index-only existence
 *   check) than reconstructing and returning a full `User` aggregate.
 */
export interface UserRepository {
  findById(id: UserId): Promise<User | undefined>;
  findByEmail(email: Email): Promise<User | undefined>;
  save(user: User): Promise<void>;
  existsByEmail(email: Email): Promise<boolean>;
}
