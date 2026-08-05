import type { UserRepository } from "../../application/ports/user-repository.js";
import type { User, UserId } from "../../domain/entities/user.js";
import type { Email } from "../../domain/value-objects/email.js";

/**
 * A `UserRepository` backed by an in-memory `Map`, satisfying the exact same
 * port a real (Phase 03, Prisma-backed) adapter will. Exists so use cases
 * and their tests never need a database — see `docs/guides/testing.md`
 * for why this and the Prisma adapter are both required to pass the same
 * `user-repository.contract.ts` suite.
 */
export class InMemoryUserRepository implements UserRepository {
  private readonly usersById = new Map<UserId, User>();

  findById(id: UserId): Promise<User | undefined> {
    return Promise.resolve(this.usersById.get(id));
  }

  findByEmail(email: Email): Promise<User | undefined> {
    return Promise.resolve([...this.usersById.values()].find((user) => user.email.equals(email)));
  }

  save(user: User): Promise<void> {
    this.usersById.set(user.id, user);
    return Promise.resolve();
  }

  existsByEmail(email: Email): Promise<boolean> {
    return Promise.resolve([...this.usersById.values()].some((user) => user.email.equals(email)));
  }
}
