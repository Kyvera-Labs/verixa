import { randomUUID } from "node:crypto";

import { Prisma, type PrismaClient, UserStatus } from "@verixa/database";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createTestPrismaClient, databaseAvailability } from "./helpers/database.js";

/**
 * Exercises the `users` table created in Issue 043 against a real Postgres.
 *
 * These assert the guarantees the *database* makes, independent of the domain
 * layer — specifically the ones the domain cannot make on its own. The domain
 * lowercases every address in `Email.create()`, so a case-differing duplicate
 * can't arise through normal application code at all; what's under test here
 * is what happens when something bypasses that path (a raw insert, a data
 * migration, a bulk import). That's exactly the scenario `citext` exists for,
 * and the only way to verify it is to actually try the insert.
 *
 * Skips when no database is reachable so a fresh clone's `pnpm test` still
 * passes; CI sets REQUIRE_DATABASE_TESTS=1 so the skip can't hide a
 * misconfigured pipeline. Issue 047 replaces the shared test database with
 * per-run Testcontainers instances.
 */

const available = await databaseAvailability();

const UNIQUE_VIOLATION = "P2002";

describe.skipIf(!available)("users table (Issue 043)", () => {
  let prisma: PrismaClient;
  const createdIds: string[] = [];

  beforeAll(() => {
    prisma = createTestPrismaClient();
  });

  afterEach(async () => {
    // Delete only what this file created, by id. A blanket `deleteMany({})`
    // would be simpler and is a trap: these tests share a long-lived database
    // with everything else in the suite, so wiping the table would make this
    // file's cleanup destructive to other tests' fixtures.
    if (createdIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdIds } } });
      createdIds.length = 0;
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  function newUser(email: string): {
    id: string;
    email: string;
    displayName: string;
    status: typeof UserStatus.pending;
    createdAt: Date;
    updatedAt: Date;
  } {
    const id = randomUUID();
    createdIds.push(id);
    const now = new Date();
    return {
      id,
      email,
      displayName: "Test User",
      status: UserStatus.pending,
      createdAt: now,
      updatedAt: now,
    };
  }

  it("persists and reads back a user", async () => {
    const data = newUser(`alice-${randomUUID()}@example.com`);

    await prisma.user.create({ data });
    const found = await prisma.user.findUnique({ where: { id: data.id } });

    expect(found?.email).toBe(data.email);
    expect(found?.displayName).toBe("Test User");
    expect(found?.status).toBe(UserStatus.pending);
  });

  it("stores an absent person name as null rather than empty string", async () => {
    const data = newUser(`bob-${randomUUID()}@example.com`);

    await prisma.user.create({ data });
    const found = await prisma.user.findUnique({ where: { id: data.id } });

    expect(found?.givenName).toBeNull();
    expect(found?.familyName).toBeNull();
  });

  it("rejects a duplicate email", async () => {
    const email = `carol-${randomUUID()}@example.com`;
    await prisma.user.create({ data: newUser(email) });

    const duplicate = prisma.user.create({ data: newUser(email) });

    await expect(duplicate).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION,
    );
  });

  it("rejects a duplicate email differing only in case (citext)", async () => {
    const local = `dave-${randomUUID()}`;
    await prisma.user.create({ data: newUser(`${local}@example.com`) });

    // Would succeed against a plain `text` column — this is the whole reason
    // the column is `citext`.
    const duplicate = prisma.user.create({ data: newUser(`${local.toUpperCase()}@EXAMPLE.COM`) });

    await expect(duplicate).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION,
    );
  });

  it("matches a lookup by email case-insensitively, without a LOWER() wrapper", async () => {
    const local = `erin-${randomUUID()}`;
    const data = newUser(`${local}@example.com`);
    await prisma.user.create({ data });

    // The payoff of citext over `text` + a functional LOWER() index: a plain
    // equality lookup is both case-insensitive *and* index-backed, with no
    // obligation on the caller to remember a wrapper.
    const found = await prisma.user.findUnique({
      where: { email: `${local.toUpperCase()}@EXAMPLE.COM` },
    });

    expect(found?.id).toBe(data.id);
  });

  it("rejects a status outside the user_status enum", async () => {
    const data = newUser(`frank-${randomUUID()}@example.com`);

    // Cast past the generated types deliberately: the point is what Postgres
    // does when something bypasses TypeScript, which is the only way an
    // invalid status could ever reach the column in practice.
    const invalid = prisma.user.create({
      data: { ...data, status: "archived" as unknown as typeof UserStatus.pending },
    });

    await expect(invalid).rejects.toThrow();
  });

  it("round-trips timestamps as instants, not local times", async () => {
    const data = newUser(`grace-${randomUUID()}@example.com`);
    await prisma.user.create({ data });

    const found = await prisma.user.findUnique({ where: { id: data.id } });

    // A `timestamp` (no timezone) column would reinterpret this against the
    // session timezone and come back shifted; `timestamptz` preserves the
    // instant regardless of where the writer and reader think they are.
    expect(found?.createdAt.toISOString()).toBe(data.createdAt.toISOString());
  });
});
