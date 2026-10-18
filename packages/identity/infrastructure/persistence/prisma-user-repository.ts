import type { PrismaClient } from "@verixa/database";

import type { UserRepository } from "../../application/ports/user-repository.js";
import type { User, UserId } from "../../domain/entities/user.js";
import type { Email } from "../../domain/value-objects/email.js";

import { withMappedErrors } from "./error-mapper.js";
import { UserMapper } from "./user-mapper.js";

/**
 * Prisma-backed `UserRepository`. Satisfies exactly the same port — and the
 * same behavioral contract (`user-repository.contract.ts`) — as
 * `InMemoryUserRepository`, which is what makes them substitutable rather
 * than merely similar.
 *
 * Takes a `PrismaClient` rather than constructing one. That's what lets a
 * caller hand it a transaction client instead (`prisma.$transaction(tx =>
 * ...)`), which Issue 048 relies on for multi-aggregate atomicity — a
 * repository that owned its own connection could never participate in
 * someone else's transaction.
 */
export class PrismaUserRepository implements UserRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findById(id: UserId): Promise<User | undefined> {
    // `findFirst`, not `findUnique`: adding the soft-delete filter makes this
    // a compound condition, and Prisma's findUnique only accepts unique-key
    // fields. Still an index lookup on the primary key.
    const row = await this.prisma.user.findFirst({ where: { id, deletedAt: null } });
    return row === null ? undefined : UserMapper.toDomain(row);
  }

  async findManyByIds(ids: readonly UserId[]): Promise<User[]> {
    if (ids.length === 0) {
      return [];
    }
    const rows = await this.prisma.user.findMany({
      where: { id: { in: [...ids] }, deletedAt: null },
    });
    return rows.map((row) => UserMapper.toDomain(row));
  }

  async findByIdIncludingDeleted(id: UserId): Promise<User | undefined> {
    const row = await this.prisma.user.findUnique({ where: { id } });
    return row === null ? undefined : UserMapper.toDomain(row);
  }

  async findByEmail(email: Email): Promise<User | undefined> {
    // No `mode: "insensitive"` and no LOWER() wrapper: the column is `citext`,
    // so plain equality is already case-insensitive *and* uses the unique
    // index. See docs/guides/database.md.
    const row = await this.prisma.user.findFirst({
      where: { email: email.value, deletedAt: null },
    });
    return row === null ? undefined : UserMapper.toDomain(row);
  }

  async save(user: User): Promise<void> {
    const row = UserMapper.toRow(user);
    const { id, ...withoutId } = row;

    // `upsert`, because the port's contract says `save` is idempotent and
    // callers don't distinguish create from update — the aggregate's state is
    // the only thing that matters. Doing this as a read-then-branch would
    // also open a race between the check and the write.
    // Writes go through the mapper; reads don't. A read that violates a
    // constraint isn't a thing — only writes produce conflicts a caller can
    // act on. See error-mapper.ts.
    await withMappedErrors("User", () =>
      this.prisma.user.upsert({
        where: { id },
        create: row,
        update: withoutId,
      }),
    );
  }

  async existsByEmail(email: Email): Promise<boolean> {
    // Deliberately not `(await findByEmail(email)) !== undefined`: this needs
    // a yes/no answer, so it selects a single column instead of every column
    // and skips reconstructing an aggregate that would be thrown away. The
    // port documents this as the reason `existsByEmail` is its own method.
    // Deliberately *not* filtered by deletedAt — see the port's soft-delete
    // note. A deleted user still occupies the email in the unique index, so
    // this has to agree with the constraint or registration fails at insert
    // rather than returning a clean conflict.
    const found = await this.prisma.user.findUnique({
      where: { email: email.value },
      select: { id: true },
    });
    return found !== null;
  }
}
