import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestPrismaClient, databaseAvailability } from "./helpers/database.js";

/**
 * Verifies the query patterns from Phases 02–03 use indexes rather than
 * sequential scans (Issue 055).
 *
 * ## Why this seeds thousands of rows
 *
 * On a small table, a sequential scan is genuinely *faster* than an index
 * scan, and Postgres will correctly choose one — reading 3 rows from a single
 * heap page beats descending a B-tree and then visiting the heap anyway. So
 * asserting "index scan" against the 3-row dev seed would fail, and the
 * obvious fix (forcing the planner with `enable_seqscan = off`) would only
 * prove Postgres obeys orders, not that the index is usable or that the
 * planner would ever pick it.
 *
 * Seeding past the point where a scan stops being cheap is what makes the
 * assertion mean something: the planner is choosing the index freely, the way
 * it would in production.
 *
 * The corollary is worth stating because it is where this kind of test
 * usually goes wrong: **a sequential scan is not a bug.** It is the right
 * plan on small tables, and on large ones when a query genuinely touches most
 * rows. What this test catches is the case where an index that *should*
 * exist doesn't — a lookup by a selective key falling back to a full scan.
 */

const available = await databaseAvailability();

const ROW_COUNT = 3000;
const OWNER_ID = "00000000-0000-4000-9000-000000000001";
const ORG_ID = "00000000-0000-4000-9000-000000000002";

interface PlanRow {
  readonly "QUERY PLAN": string;
}

describe.skipIf(!available)("index usage (Issue 055)", () => {
  const prisma = createTestPrismaClient();

  /**
   * Runs EXPLAIN (no ANALYZE) and returns the plan as one string.
   *
   * Callers pass the *whole* statement, `EXPLAIN` included. This helper used to
   * build it as `` `EXPLAIN ${sql}` ``, which is the exact shape Issue 210's
   * lint rule exists to catch: a raw-query call fed a string assembled at
   * runtime. Here the pieces were always literals inside this file, so it was
   * safe — and safe-by-inspection is precisely what a reviewer cannot check on
   * a diff. Moving the keyword into each call site makes every statement this
   * suite runs a single fixed literal, with nothing concatenated.
   *
   * Every placeholder below carries an explicit `::type` cast, and that is
   * load-bearing rather than decorative. `$queryRawUnsafe` binds parameters
   * as `text`, so an uncast `WHERE email = $1` asks Postgres to compare
   * `citext` against `text`. It resolves that by casting the *column*, and
   * the plan comes back reading `Filter: ((email)::text = '...'::text)` — a
   * sequential scan, because an index on `email` cannot answer a query about
   * `email::text`. On a uuid column it does not even get that far: there is
   * no `uuid = text` operator, so it fails outright with 42883.
   *
   * Both are artefacts of raw SQL in this file, not of the schema — Prisma's
   * generated queries bind with the correct types. Casting the parameter
   * instead of the column is what makes these assertions measure the schema.
   */
  async function explain(statement: string, ...params: unknown[]): Promise<string> {
    const rows = await prisma.$queryRawUnsafe<PlanRow[]>(statement, ...params);
    return rows.map((row) => row["QUERY PLAN"]).join("\n");
  }

  /**
   * Asserts the plan reads the table through an index.
   *
   * Matches "Index Scan", "Index Only Scan", and "Bitmap Index Scan" — all
   * three are index access; which one the planner picks depends on
   * selectivity and row width, and pinning a specific one would make this
   * test fail on a planner decision that isn't a regression.
   */
  function expectIndexed(plan: string, table: string): void {
    const usesIndex = /Index (Only )?Scan|Bitmap Index Scan/.test(plan);
    expect(usesIndex, `Expected an index scan on ${table}, got:\n${plan}`).toBe(true);
  }

  beforeAll(async () => {
    await prisma.invitation.deleteMany({});
    await prisma.organizationMembership.deleteMany({});
    await prisma.organization.deleteMany({});
    await prisma.user.deleteMany({});

    const now = new Date();
    await prisma.user.create({
      data: {
        id: OWNER_ID,
        email: "index-owner@example.com",
        displayName: "Index Owner",
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
    });
    await prisma.organization.create({
      data: {
        id: ORG_ID,
        name: "Index Org",
        slug: "index-org",
        ownerId: OWNER_ID,
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
    });

    const users = Array.from({ length: ROW_COUNT }, () => ({
      id: randomUUID(),
      email: `bulk-${randomUUID()}@example.com`,
      displayName: "Bulk User",
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    }));
    await prisma.user.createMany({ data: users });

    // Organizations get bulked up too. With a single row, a sequential scan
    // is the *correct* plan and asserting an index scan would be asserting
    // that the planner is wrong — the same trap this file's header warns
    // about. Only the row count makes the slug assertion meaningful.
    const bulkOrganizationIds = Array.from({ length: ROW_COUNT }, () => randomUUID());
    await prisma.organization.createMany({
      data: bulkOrganizationIds.map((id, offset) => ({
        id,
        name: `Bulk Org ${String(offset)}`,
        slug: `bulk-org-${String(offset)}`,
        ownerId: OWNER_ID,
        status: "active" as const,
        createdAt: now,
        updatedAt: now,
      })),
    });

    /**
     * How many child rows hang off ORG_ID, as opposed to one of the bulk
     * organizations.
     *
     * This number is the point of the whole seed. Putting every membership
     * and invitation on ORG_ID makes `WHERE organization_id = $1` match 100%
     * of the table, and a sequential scan is then genuinely the faster plan —
     * Postgres would be right to choose it, and an assertion demanding an
     * index would be asserting the planner is broken. Spreading the rows so
     * ORG_ID holds a small slice is what makes the predicate selective, and
     * selectivity is the only reason an index is ever the better answer.
     *
     * Kept comfortably above `LIMIT 50` so the limit is not what makes the
     * query cheap, and well under the ~5-10% where a scan takes over again.
     */
    const ROWS_ON_TARGET_ORG = 60;

    /** ORG_ID for the first rows, spread across the bulk orgs thereafter. */
    function organizationFor(offset: number): string {
      if (offset < ROWS_ON_TARGET_ORG) return ORG_ID;
      return bulkOrganizationIds[offset % bulkOrganizationIds.length] ?? ORG_ID;
    }

    await prisma.organizationMembership.createMany({
      data: [
        // The owner's own membership, which the composite-index test below
        // looks for by name. Without it that test asserts an index is used to
        // find nothing, which is a weaker claim than it appears to make.
        {
          id: randomUUID(),
          userId: OWNER_ID,
          organizationId: ORG_ID,
          status: "active" as const,
          joinedAt: now,
        },
        ...users.map((user, offset) => ({
          id: randomUUID(),
          userId: user.id,
          organizationId: organizationFor(offset),
          status: "revoked" as const,
          joinedAt: now,
        })),
      ],
    });

    await prisma.invitation.createMany({
      data: Array.from({ length: ROW_COUNT }, (_unused, offset) => ({
        id: randomUUID(),
        organizationId: organizationFor(offset),
        invitedByUserId: OWNER_ID,
        email: `invite-${randomUUID()}@example.com`,
        tokenHash: randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""),
        status: "pending" as const,
        createdAt: now,
        expiresAt: new Date(now.getTime() + 86_400_000),
      })),
    });

    // Without fresh statistics the planner is working from defaults and may
    // choose a scan regardless of what indexes exist. ANALYZE is what makes
    // the assertions below a test of the schema rather than of table
    // staleness.
    await prisma.$executeRawUnsafe(
      "ANALYZE users, organizations, organization_memberships, invitations;",
    );
  }, 180_000);

  afterAll(async () => {
    await prisma.invitation.deleteMany({});
    await prisma.organizationMembership.deleteMany({});
    await prisma.organization.deleteMany({});
    await prisma.user.deleteMany({});
    await prisma.$disconnect();
  }, 120_000);

  it("looks up a user by email via the unique index", async () => {
    const plan = await explain(
      "EXPLAIN SELECT * FROM users WHERE email = $1::citext",
      "index-owner@example.com",
    );

    // Also the payoff of `citext` over `text` + a LOWER() functional index:
    // plain equality is index-backed with no wrapper at the call site.
    expectIndexed(plan, "users");
  });

  it("looks up an organization by slug via the unique index", async () => {
    const plan = await explain(
      "EXPLAIN SELECT * FROM organizations WHERE slug = $1::citext",
      "index-org",
    );

    expectIndexed(plan, "organizations");
  });

  it("looks up an invitation by token hash via the unique index", async () => {
    const plan = await explain(
      "EXPLAIN SELECT * FROM invitations WHERE token_hash = $1::text",
      "0".repeat(64),
    );

    expectIndexed(plan, "invitations");
  });

  it("finds a user's membership in an organization via the composite index", async () => {
    const plan = await explain(
      "EXPLAIN SELECT * FROM organization_memberships WHERE user_id = $1::uuid AND organization_id = $2::uuid",
      OWNER_ID,
      ORG_ID,
    );

    expectIndexed(plan, "organization_memberships");
  });

  it("finds pending invitations for an organization via the composite index", async () => {
    const plan = await explain(
      "EXPLAIN SELECT * FROM invitations WHERE organization_id = $1::uuid AND status = 'pending' LIMIT 50",
      ORG_ID,
    );

    expectIndexed(plan, "invitations");
  });

  it("scans expiring invitations via the expires_at index", async () => {
    // The retention/expiry sweep. Narrow window on purpose: asking for
    // invitations expiring in the next minute is selective, so an index is
    // the right plan. Asking for all of them would correctly seq-scan.
    const plan = await explain(
      "EXPLAIN SELECT * FROM invitations WHERE expires_at < $1::timestamptz",
      new Date(Date.now() - 86_400_000),
    );

    expectIndexed(plan, "invitations");
  });

  it("keeps the organization_id index despite the composite one (leftmost prefix)", async () => {
    // `@@index([userId, organizationId])` cannot serve a query filtering on
    // organizationId alone — a B-tree is only usable from its leading
    // column. That is why `@@index([organizationId])` exists separately and
    // is not redundant, which is the least obvious call in this schema.
    const plan = await explain(
      "EXPLAIN SELECT * FROM organization_memberships WHERE organization_id = $1::uuid LIMIT 50",
      ORG_ID,
    );

    expectIndexed(plan, "organization_memberships");
  });

  it("correctly chooses a sequential scan for an unselective query", async () => {
    // The other half of the discipline. Reading most of the table through an
    // index would be slower than reading it straight through, and Postgres
    // knows that. A test suite that treated every seq scan as a failure would
    // push toward indexes that make things worse.
    const plan = await explain("EXPLAIN SELECT * FROM users WHERE status = 'active'");

    expect(plan).toMatch(/Seq Scan/);
  });
});
