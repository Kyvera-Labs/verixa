import { describe, expect, it } from "vitest";

import { Prisma, PrismaClient } from "./index.js";

/**
 * These assert that the generated client exists and is exported correctly —
 * not that it can reach a database. Actual database behavior is covered by
 * the migration check in CI and, from Issue 046, the repository contract
 * tests running against a real Postgres.
 *
 * The failure this catches is a real and easy one to hit: the generated
 * client is git-ignored and platform-specific, so a fresh clone that skipped
 * `pnpm db:generate` has no client at all. Better to fail here, on an
 * obvious assertion, than several layers deep in an unrelated test.
 *
 * Deliberately does *not* call `new PrismaClient()`: the client is built from
 * layered proxies, and instantiating it inside Vitest trips the runner's
 * object inspection into unbounded recursion (`Maximum call stack size
 * exceeded`). Checking the exported shape proves generation succeeded, which
 * is all this test is for — a test that fights the runner to assert something
 * it already knows is worse than a narrower one that passes honestly.
 */
describe("@verixa/database", () => {
  it("exports PrismaClient as a constructor", () => {
    expect(typeof PrismaClient).toBe("function");
    expect(PrismaClient.prototype).toBeDefined();
  });

  it("exports the Prisma namespace helper", () => {
    expect(Prisma).toBeDefined();
    expect(typeof Prisma.defineExtension).toBe("function");
  });
});
