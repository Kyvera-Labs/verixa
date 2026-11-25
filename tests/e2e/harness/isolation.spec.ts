import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createTestPrismaClient,
  databaseAvailability,
} from "../../integration/helpers/database.js";

import { resetDatabase, withDatabaseReset } from "./reset-database.js";
import { seedOrganization, seedRole, seedUser } from "./seed.js";

const available = await databaseAvailability();

describe.skipIf(!available)("E2E test data seeding & isolation strategy", () => {
  const prisma = createTestPrismaClient();

  beforeAll(async () => {
    await prisma.$connect();
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  it("resetDatabase cleans all tables completely", async () => {
    const user = await seedUser(prisma, { displayName: "Isolation User" });
    await seedOrganization(prisma, { ownerId: user.id });
    await seedRole(prisma, { name: "isolation-role" });

    expect(await prisma.user.count()).toBeGreaterThan(0);
    expect(await prisma.organization.count()).toBeGreaterThan(0);
    expect(await prisma.role.count()).toBeGreaterThan(0);

    await resetDatabase(prisma);

    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.organization.count()).toBe(0);
    expect(await prisma.role.count()).toBe(0);
  });

  it("teardown runs even when an action throws an error mid-way", async () => {
    let caughtError: unknown;
    try {
      await withDatabaseReset(prisma, async () => {
        await seedUser(prisma, { displayName: "Failing Test User" });
        expect(await prisma.user.count()).toBe(1);
        throw new Error("Deliberate mid-test failure");
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(Error);
    // Teardown in finally must have cleared the database
    expect(await prisma.user.count()).toBe(0);
  });

  it("two sequential operations produce zero state leakage between each other", async () => {
    // Operation 1
    await withDatabaseReset(prisma, async () => {
      await seedUser(prisma, { email: "op1@example.com" });
      const users = await prisma.user.findMany();
      expect(users).toHaveLength(1);
      expect(users[0]?.email).toBe("op1@example.com");
    });

    // Operation 2 - completely isolated from Operation 1
    await withDatabaseReset(prisma, async () => {
      expect(await prisma.user.count()).toBe(0);
      await seedUser(prisma, { email: "op2@example.com" });
      const users = await prisma.user.findMany();
      expect(users).toHaveLength(1);
      expect(users[0]?.email).toBe("op2@example.com");
    });
  });

  it("executing operations in arbitrary/reversed order produces identical isolated states", async () => {
    const runOrderA = async () => {
      return await withDatabaseReset(prisma, async () => {
        const u = await seedUser(prisma, { email: "order-a@example.com" });
        return u.email;
      });
    };

    const runOrderB = async () => {
      return await withDatabaseReset(prisma, async () => {
        const r = await seedRole(prisma, { name: "order-b-role" });
        return r.name;
      });
    };

    // Execution in Order A then B
    const resA1 = await runOrderA();
    const resB1 = await runOrderB();

    // Execution in Order B then A
    const resB2 = await runOrderB();
    const resA2 = await runOrderA();

    expect(resA1).toBe(resA2);
    expect(resB1).toBe(resB2);
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.role.count()).toBe(0);
  });
});
