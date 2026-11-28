import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestPrismaClient, databaseAvailability } from "./helpers/database.js";

/**
 * Verifies the main query patterns use indexes rather than sequential scans. Thousands of rows are
 * seeded so the planner chooses indexes freely; on a tiny table a sequential scan is correctly
 * cheaper. A sequential scan is not a bug in itself: this catches a selective lookup with no usable
 * index.
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
   * Runs EXPLAIN (without ANALYZE) and returns the plan as one string. Callers pass the whole
   * statement, including `EXPLAIN`, so every query is a fixed literal with nothing concatenated.
   *
   * Every placeholder has an explicit `::type` cast. `$queryRawUnsafe` binds text, so an uncast
   * `citext` comparison casts the column and seq-scans, and an uncast uuid comparison fails
   * (42883). Prisma's own queries bind the correct types.
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
     * Child rows on `ORG_ID`, kept to a small slice of the table so `WHERE organization_id = $1` is
     * selective and an index is genuinely the better plan. Above `LIMIT 50`, and well under the
     * share where a scan wins again.
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
