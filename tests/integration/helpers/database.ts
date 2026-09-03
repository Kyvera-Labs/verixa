import { PrismaClient } from "@verixa/database";

import { canConnect } from "./tcp-connect.js";

export const DEFAULT_TEST_DATABASE_URL = "postgres://verixa:verixa@localhost:5432/verixa_test";

export function testDatabaseUrl(): string {
  return process.env["TEST_DATABASE_URL"] ?? DEFAULT_TEST_DATABASE_URL;
}

/**
 * Whether a Postgres instance is actually listening for the test database.
 *
 * Database-backed tests skip when this is `false`, so `pnpm test` passes on a
 * fresh clone with no Docker running — a contributor's first command
 * shouldn't fail for reasons that have nothing to do with their change.
 *
 * The obvious hazard with skip-on-unavailable is that coverage disappears
 * silently: if CI's Postgres service were misconfigured, every one of these
 * tests would skip and the pipeline would still go green, which is worse
 * than failing. {@link assertDatabaseAvailableWhenRequired} closes that hole
 * — CI sets `REQUIRE_DATABASE_TESTS=1`, which turns an unreachable database
 * from a skip into a hard failure.
 */
export async function isDatabaseAvailable(): Promise<boolean> {
  const url = new URL(testDatabaseUrl());
  return canConnect(url.hostname, Number(url.port || 5432));
}

/**
 * Resolves database availability and enforces it where it's mandatory.
 * Call at module top level:
 *
 * ```ts
 * const available = await databaseAvailability();
 * describe.skipIf(!available)("...", () => { ... });
 * ```
 *
 * Top level specifically, not from `beforeAll`. Vitest skips a suite's hooks
 * along with its tests, so an assertion inside `beforeAll` of a
 * `describe.skipIf`-ed block never executes — which made an earlier version
 * of this guard silently do nothing in exactly the situation it existed to
 * catch. Throwing during module evaluation fails collection, and collection
 * always runs.
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
  return new PrismaClient({ datasources: { db: { url: testDatabaseUrl() } } });
}
