import { createPrismaClient, type PrismaClient } from "@verixa/database";

import { canConnect } from "./tcp-connect.js";

export const DEFAULT_TEST_DATABASE_URL = "postgres://verixa:verixa@localhost:5432/verixa_test";

export function testDatabaseUrl(): string {
  return process.env["TEST_DATABASE_URL"] ?? DEFAULT_TEST_DATABASE_URL;
}

/**
 * Whether Postgres is listening for the test database. Database tests skip when it is not, so `pnpm
 * test` passes on a fresh clone; CI sets `REQUIRE_DATABASE_TESTS=1` so a missing database fails
 * instead (see {@link assertDatabaseAvailableWhenRequired}).
 */
export async function isDatabaseAvailable(): Promise<boolean> {
  const url = new URL(testDatabaseUrl());
  return canConnect(url.hostname, Number(url.port || 5432));
}

/**
 * Resolves database availability and enforces it where required. Call at module top level:
 *
 * ```ts
 * const available = await databaseAvailability();
 * describe.skipIf(!available)("...", () => { ... });
 * ```
 *
 * Not from `beforeAll`: Vitest skips the hooks of a skipped suite, so the check would never run.
 * Throwing during module evaluation fails collection, which always runs.
 */
export async function databaseAvailability(): Promise<boolean> {
  const available = await isDatabaseAvailable();

  if (!available && process.env["REQUIRE_DATABASE_TESTS"] === "1") {
    throw new Error(
      `REQUIRE_DATABASE_TESTS=1 but no database is reachable at ${testDatabaseUrl()}. ` +
        "Database-backed tests must not silently skip in CI.",
    );
  }

  return available;
}

/**
 * A Prisma client pointed at the test database.
 *
 * Takes the URL explicitly rather than relying on the ambient `DATABASE_URL`
 * that `schema.prisma` reads: the test database and the development database
 * are different databases, and a test suite that truncates tables must never
 * be one environment variable away from doing that to a developer's own data.
 */
export function createTestPrismaClient(): PrismaClient {
  return createPrismaClient(testDatabaseUrl());
}
