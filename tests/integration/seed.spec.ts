import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createTestPrismaClient,
  databaseAvailability,
  testDatabaseUrl,
} from "./helpers/database.js";

/**
 * Verifies `pnpm db:seed` is genuinely idempotent (Issue 051).
 *
 * Runs the real script as a subprocess rather than importing and calling it.
 * Importing would test a function; this tests the thing a contributor
 * actually runs, including the script's own client setup and exit handling —
 * the parts most likely to be subtly wrong.
 */

const available = await databaseAvailability();

const databasePackageRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../packages/database",
);

function runSeed(): void {
  execFileSync("pnpm", ["run", "db:seed"], {
    cwd: databasePackageRoot,
    env: { ...process.env, DATABASE_URL: testDatabaseUrl() },
    stdio: "pipe",
    shell: process.platform === "win32",
  });
}

describe.skipIf(!available)("db:seed", () => {
  const prisma = createTestPrismaClient();

  beforeAll(async () => {
    // Seed fixtures use fixed ids that could collide with rows other suites
    // left behind. Order matters: organizations.owner_id is ON DELETE
    // RESTRICT, so users go last.
    await prisma.invitation.deleteMany({});
    await prisma.organizationMembership.deleteMany({});
    await prisma.organization.deleteMany({});
    await prisma.user.deleteMany({});
  });

  afterAll(async () => {
    await prisma.invitation.deleteMany({});
    await prisma.organizationMembership.deleteMany({});
    await prisma.organization.deleteMany({});
    await prisma.user.deleteMany({});
    await prisma.$disconnect();
  });

  it("is safe to run twice, producing the same rows and no duplicates", async () => {
    runSeed();

    const afterFirst = {
      users: await prisma.user.count(),
      organizations: await prisma.organization.count(),
      memberships: await prisma.organizationMembership.count(),
    };
    expect(afterFirst).toEqual({ users: 3, organizations: 2, memberships: 4 });

    // The actual assertion: a second run must not throw on a unique
    // constraint, and must not add anything. A seed that only works against
    // an empty database is a seed nobody can safely re-run.
    runSeed();

    const afterSecond = {
      users: await prisma.user.count(),
      organizations: await prisma.organization.count(),
      memberships: await prisma.organizationMembership.count(),
    };
    expect(afterSecond).toEqual(afterFirst);
  }, 120_000);

  it("produces deterministic ids, so fixtures are referenceable across resets", async () => {
    const alice = await prisma.user.findUnique({
      where: { id: "00000000-0000-4000-8000-000000000001" },
    });

    expect(alice?.email).toBe("alice@example.com");
  });

  it("seeds a user belonging to two organizations", async () => {
    // The case naive multi-tenancy designs get wrong, and the reason ADR-0002
    // chose row-level isolation — so it should be present in the default
    // local dataset rather than something a contributor has to construct.
    const bobMemberships = await prisma.organizationMembership.findMany({
      where: { userId: "00000000-0000-4000-8000-000000000002", status: "active" },
    });

    expect(bobMemberships).toHaveLength(2);
  });

  it("seeds no invitations, since a seeded token would be a committed credential", async () => {
    await expect(prisma.invitation.count()).resolves.toBe(0);
  });
});
