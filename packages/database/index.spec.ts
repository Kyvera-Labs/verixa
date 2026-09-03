import { describe, expect, it } from "vitest";

import { Prisma, PrismaClient, UserStatus, type UserRow } from "./index.js";

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

  it("generated a User model from the schema", () => {
    expect(Prisma.ModelName.User).toBe("User");
  });
});

describe("UserStatus enum", () => {
  /**
   * Pins the database enum to the four states the domain defines in
   * packages/identity/domain/entities/user.ts. Adding a status there without
   * a matching migration would let the domain produce a value Postgres
   * rejects at write time — a failure that would otherwise surface as a
   * runtime error in production rather than a failing test here.
   *
   * This is a *pin*, not yet an automatic cross-check: `@verixa/database`
   * doesn't depend on `@verixa/identity` (the dependency runs the other way,
   * starting with the repository adapter in Issue 046), so this list is
   * duplicated by hand rather than imported. Issue 046 is where the two are
   * genuinely reconciled — the mapper has to convert between them, so a
   * mismatch becomes a type error there.
   */
  it("contains exactly the statuses the domain defines, with identical casing", () => {
    // Asserted as one whole-object comparison rather than a loop indexing
    // `UserStatus[status]`: dynamic property access on an object trips
    // `security/detect-object-injection`, and restructuring to avoid the
    // pattern is better than suppressing the rule. This also asserts more —
    // keys, values, and the absence of any extra member, in one expression.
    //
    // Identical casing is the point of the value half: the domain union uses
    // lowercase, so matching it exactly means adapters can pass a status
    // straight through with no translation table to drift out of sync.
    expect({ ...UserStatus }).toEqual({
      pending: "pending",
      active: "active",
      suspended: "suspended",
      deleted: "deleted",
    });
  });
});

describe("UserRow type", () => {
  it("has every column the users table defines", () => {
    // A compile-time assertion in test's clothing: if a column is renamed,
    // removed, or changes type in schema.prisma, this object stops satisfying
    // UserRow and `pnpm typecheck` fails. The runtime expectation below is
    // incidental — the type annotation is the actual test.
    const row: UserRow = {
      id: "00000000-0000-0000-0000-000000000001",
      email: "alice@example.com",
      displayName: "Alice",
      givenName: null,
      familyName: null,
      status: UserStatus.pending,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    expect(row.id).toBe("00000000-0000-0000-0000-000000000001");
  });

  it("models the optional person name as nullable, matching the domain's optional PersonName", () => {
    const withPersonName: Pick<UserRow, "givenName" | "familyName"> = {
      givenName: "Alice",
      familyName: "Smith",
    };

    expect(withPersonName.givenName).toBe("Alice");
  });
});
