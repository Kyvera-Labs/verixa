import { randomUUID } from "node:crypto";

import {
  type AuditDelegate,
  type AuditTransaction,
  ChainConflictError,
  PrismaAuditLogRepository,
  RecordAuditEvent,
  verifyChain,
} from "@verixa/audit";
// The testing entry point, deliberately. This suite forges a forked chain entry
// to prove the repository refuses it, which needs the chain's own primitives.
// They are kept off the package's main surface precisely so nothing that ships
// can mint an entry -- see `packages/audit/testing.ts`.
import { AuditLogEntry, AuditLogEntryMapper, GENESIS_HASH } from "@verixa/audit/testing";
import { Result } from "@verixa/shared-kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestPrismaClient, databaseAvailability } from "./helpers/database.js";

/**
 * Concurrent audit appends and index usage against a real Postgres.
 *
 * The first `describe` shows that under `READ COMMITTED` two overlapping appends can read the same
 * head, so the unique index on `sequence`, not the transaction, prevents a fork (which is why the
 * `P2002` translation exists). The second seeds thousands of rows to show `findWithFilters` uses
 * indexes.
 *
 * Both need exclusive use of `audit_log_entries`, so they share one file: Vitest finishes one
 * `describe` before starting the next, whereas `fileParallelism: false` does not stop one file's
 * teardown overlapping the next file's setup. Skips without a database unless
 * `REQUIRE_DATABASE_TESTS=1`.
 */

const available = await databaseAvailability();

// actorId is `@db.Uuid`; Postgres rejects anything that isn't a real UUID
// rather than storing it as an opaque string, so these must be valid UUIDs,
// not readable labels.
const RACER_A_ID = "00000000-0000-4000-9000-00000000a001";
const RACER_B_ID = "00000000-0000-4000-9000-00000000a002";
const RIVAL_ID = "00000000-0000-4000-9000-00000000a003";
const FORK_ID = "00000000-0000-4000-9000-00000000a004";

describe.skipIf(!available)("audit chain concurrency (Issue #128)", () => {
  const prisma = createTestPrismaClient();

  const transaction: AuditTransaction = <T>(
    work: (entries: AuditDelegate) => Promise<T>,
  ): Promise<T> => prisma.$transaction(async (tx) => work(tx.auditLogEntry));

  const repository = new PrismaAuditLogRepository(prisma.auditLogEntry, transaction);

  beforeAll(async () => {
    // A hash chain can only be verified from its first entry, so this suite
    // owns the whole table for its duration -- see the module comment above
    // on why that is enforced by file order rather than by assumption.
    await prisma.auditLogEntry.deleteMany({});
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function storedChain(): Promise<ReturnType<typeof toEntries>> {
    return toEntries(await prisma.auditLogEntry.findMany({ orderBy: { sequence: "asc" } }));
  }

  function toEntries(
    rows: {
      id: string;
      sequence: number;
      action: string;
      actorId: string | null;
      subjectId: string | null;
      metadata: unknown;
      occurredAt: Date;
      previousHash: string;
      hash: string;
    }[],
  ) {
    return rows.map((row) => AuditLogEntryMapper.toDomain(row));
  }

  it("serializes two appends that both claim the same head", async () => {
    // Both writers start against an empty log, so both build a first entry that
    // claims sequence 1 and links to the genesis hash. Only one can commit; the
    // loser is expected to re-read and relink, which is what separates a
    // retryable conflict from a lost event.
    const recorder = new RecordAuditEvent(repository);

    const results = await Promise.all([
      recorder.execute({ action: "user.login_succeeded", actorId: RACER_A_ID }),
      recorder.execute({ action: "user.login_failed", actorId: RACER_B_ID }),
    ]);

    expect(results.filter((entry) => entry !== undefined)).toHaveLength(2);

    const chain = await storedChain();
    expect(chain).toHaveLength(2);
    expect(chain[0]?.sequence).toBe(1);
    expect(chain[0]?.previousHash).toBe(GENESIS_HASH);
    expect(chain[1]?.previousHash).toBe(chain[0]?.hash);
    expect(verifyChain(chain)).toBeUndefined();
  });

  it("refuses an append that names a stale head, and writes nothing", async () => {
    const head = await repository.findLatest();
    if (head === undefined) throw new Error("expected a head from the previous test");

    // The chain moves under the caller's feet.
    const rival = await new RecordAuditEvent(repository).execute({
      action: "user.login_succeeded",
      actorId: RIVAL_ID,
    });
    expect(rival).toBeDefined();

    // An entry built against the superseded head is a fork. Inserting it would
    // produce two entries claiming to follow the same predecessor, and
    // `verifyChain` could no longer tell which history is the real one.
    const forked = AuditLogEntry.append({
      action: "user.locked_out",
      actorId: FORK_ID,
      previous: head,
    });

    const outcome = await repository.append(forked, head.hash);
    expect(Result.isErr(outcome)).toBe(true);
    if (Result.isErr(outcome)) {
      expect(outcome.error).toBeInstanceOf(ChainConflictError);
      expect(outcome.error.actualPreviousHash).toBe(rival?.hash);
    }

    const chain = await storedChain();
    expect(chain).toHaveLength(3);
    expect(chain.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
    expect(verifyChain(chain)).toBeUndefined();
  });
});

/**
 * Checks that each `findWithFilters` filter path uses an index rather than a sequential scan.
 *
 * Thousands of rows are seeded so the planner chooses the index on its own; on a tiny table a
 * sequential scan is correctly cheaper, and forcing `enable_seqscan = off` would prove nothing.
 * Each target value owns a small slice of the table so the predicate is selective.
 *
 * `organizationId` is not asserted: it lives in the JSON `metadata` column and needs a functional
 * index Prisma cannot express (see docs/performance/audit-query-benchmarks.md).
 */
const ROW_COUNT = 5000;
const TARGET_ROWS = 50;
const TARGET_ACTOR_ID = "00000000-0000-4000-9000-0000000000a1";
const TARGET_SUBJECT_ID = "00000000-0000-4000-9000-0000000000b1";
const TARGET_ACTION = "user.login_failed";

interface PlanRow {
  readonly "QUERY PLAN": string;
}

describe.skipIf(!available)("audit query index usage (Issue 188)", () => {
  const prisma = createTestPrismaClient();

  /**
   * Runs EXPLAIN and returns the plan as one string. Every parameter has an explicit `::type` cast,
   * because `$queryRawUnsafe` binds text and an uncast comparison casts the column instead,
   * defeating its index.
   */
  async function explain(statement: string, ...params: unknown[]): Promise<string> {
    const rows = await prisma.$queryRawUnsafe<PlanRow[]>(statement, ...params);
    return rows.map((row) => row["QUERY PLAN"]).join("\n");
  }

  /** All three of these are index access; which one wins is the planner's call. */
  function expectIndexed(plan: string, table: string): void {
    const usesIndex = /Index (Only )?Scan|Bitmap Index Scan/.test(plan);
    expect(usesIndex, `Expected an index scan on ${table}, got:\n${plan}`).toBe(true);
  }

  beforeAll(async () => {
    await prisma.auditLogEntry.deleteMany({});

    const baseTime = new Date("2026-01-01T00:00:00.000Z").getTime();
    const rows = Array.from({ length: ROW_COUNT }, (_unused, offset) => {
      // The first TARGET_ROWS rows carry each target value; the rest are
      // spread over random values so no target owns more than a small slice.
      const isTarget = offset < TARGET_ROWS;
      return {
        id: randomUUID(),
        sequence: offset + 1,
        action: isTarget && offset % 2 === 0 ? TARGET_ACTION : "user.login_succeeded",
        actorId: isTarget ? TARGET_ACTOR_ID : randomUUID(),
        subjectId: isTarget ? TARGET_SUBJECT_ID : randomUUID(),
        metadata: { organizationId: randomUUID() },
        // Spread two hours; the target window below is the first minute.
        occurredAt: new Date(baseTime + offset * 1_500),
        previousHash: randomUUID().replace(/-/g, "").repeat(2),
        hash: `${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`,
      };
    });

    await prisma.auditLogEntry.createMany({ data: rows });

    // The planner works from statistics. Without fresh ones it may choose a
    // scan regardless of the indexes, making this a test of table staleness
    // rather than of the schema.
    await prisma.$executeRawUnsafe("ANALYZE audit_log_entries;");
  }, 180_000);

  afterAll(async () => {
    await prisma.auditLogEntry.deleteMany({});
    await prisma.$disconnect();
  }, 120_000);

  it("filters by actor using the (actor_id, sequence) index", async () => {
    const plan = await explain(
      "EXPLAIN SELECT * FROM audit_log_entries WHERE sequence >= $1::int AND actor_id = $2::uuid ORDER BY sequence ASC LIMIT 50",
      1,
      TARGET_ACTOR_ID,
    );

    // Not asserting "no Sort" here: the planner is free to pick a Bitmap
    // Index Scan over a plain Index Scan based on its cost estimates, and a
    // bitmap scan legitimately needs an explicit Sort afterward, since it
    // reorders by heap page rather than by index order. Which of the two
    // index strategies wins is a planner judgment call, not part of what
    // this test is claiming; `expectIndexed` already proves the real claim
    // — that this is served by an index, not a sequential scan.
    expectIndexed(plan, "audit_log_entries");
  });

  it("filters by subject using the (subject_id, sequence) index", async () => {
    const plan = await explain(
      "EXPLAIN SELECT * FROM audit_log_entries WHERE sequence >= $1::int AND subject_id = $2::uuid ORDER BY sequence ASC LIMIT 50",
      1,
      TARGET_SUBJECT_ID,
    );

    expectIndexed(plan, "audit_log_entries");
  });

  it("filters by action using the (action, sequence) index", async () => {
    const plan = await explain(
      "EXPLAIN SELECT * FROM audit_log_entries WHERE sequence >= $1::int AND action = $2::text ORDER BY sequence ASC LIMIT 50",
      1,
      TARGET_ACTION,
    );

    expectIndexed(plan, "audit_log_entries");
  });

  it("filters by date range using the (occurred_at, sequence) index", async () => {
    // A selectively narrow tail of the spread, not "everything after the
    // epoch": a predicate matching most of the table is supposed to seq-scan.
    const windowStart = new Date(
      new Date("2026-01-01T00:00:00.000Z").getTime() + (ROW_COUNT - TARGET_ROWS) * 1_500,
    );

    const plan = await explain(
      "EXPLAIN SELECT * FROM audit_log_entries WHERE sequence >= $1::int AND occurred_at >= $2::timestamptz ORDER BY sequence ASC LIMIT 50",
      1,
      windowStart,
    );

    // No "no Sort" assertion here, deliberately: the index is ordered by
    // (occurred_at, sequence), so a range on occurred_at leaves `sequence`
    // unordered and a sort is expected. It is the actor/subject/action paths —
    // equality on the leading column — that get ordering for free.
    expectIndexed(plan, "audit_log_entries");
  });

  it("walks the keyset via the unique sequence index", async () => {
    const plan = await explain(
      "EXPLAIN SELECT * FROM audit_log_entries WHERE sequence >= $1::int ORDER BY sequence ASC LIMIT 50",
      ROW_COUNT - 100,
    );

    expectIndexed(plan, "audit_log_entries");
    expect(plan).not.toMatch(/Sort/);
  });
});
