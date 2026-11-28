import { randomUUID } from "node:crypto";

import { createPrismaClient } from "../index.js";

/**
 * Seeds the audit log at scale and prints the `EXPLAIN (ANALYZE, BUFFERS)` plan for every filter
 * path: `BENCH_ROWS=100000 pnpm --filter @verixa/database run benchmark:audit`.
 *
 * The manual, large-scale counterpart to `tests/integration/audit-query-index-usage.spec.ts`;
 * planners can switch strategies at scale, so a path that uses an index at thousands of rows may
 * not at hundreds of thousands. Not run in CI because it is slow and machine-dependent.
 *
 * To reproduce the documented numbers, see docs/performance/audit-query-benchmarks.md. Seeded rows
 * are removed on exit.
 */
const ROWS = Number(process.env["BENCH_ROWS"] ?? 100_000);
const MARKER = "issue-188-benchmark";
const TARGET_ROWS = Math.max(50, Math.round(ROWS * 0.001));
const TARGET_ACTOR_ID = "00000000-0000-4000-9000-0000000000a1";
const TARGET_SUBJECT_ID = "00000000-0000-4000-9000-0000000000b1";
const TARGET_ACTION = "user.login_failed";
const BASE_TIME = new Date("2026-01-01T00:00:00.000Z").getTime();
const STEP_MS = 1_500;

interface PlanRow {
  readonly "QUERY PLAN": string;
}

const databaseUrl = process.env["DATABASE_URL"] ?? "postgres://verixa:verixa@localhost:5432/verixa";
const prisma = createPrismaClient(databaseUrl);

async function seed(): Promise<void> {
  const batchSize = 5_000;

  for (let start = 0; start < ROWS; start += batchSize) {
    const end = Math.min(start + batchSize, ROWS);
    const batch = Array.from({ length: end - start }, (_unused, offsetInBatch) => {
      const offset = start + offsetInBatch;
      const isTarget = offset < TARGET_ROWS;
      return {
        id: randomUUID(),
        sequence: offset + 1,
        action: isTarget && offset % 2 === 0 ? TARGET_ACTION : "user.login_succeeded",
        actorId: isTarget ? TARGET_ACTOR_ID : randomUUID(),
        subjectId: isTarget ? TARGET_SUBJECT_ID : randomUUID(),
        // The JSON metadata carries the organisation, as the real subscriber
        // writes it. It also carries the marker this script deletes by.
        metadata: { organizationId: randomUUID(), benchmark: MARKER },
        occurredAt: new Date(BASE_TIME + offset * STEP_MS),
        previousHash: randomUUID().replace(/-/g, "").repeat(2),
        hash: `${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`,
      };
    });

    await prisma.auditLogEntry.createMany({ data: batch });
    process.stdout.write(`\rseeded ${String(end)}/${String(ROWS)}`);
  }

  process.stdout.write("\n");
  await prisma.$executeRawUnsafe("ANALYZE audit_log_entries;");
}

async function explain(label: string, statement: string, ...params: unknown[]): Promise<void> {
  const started = performance.now();
  const rows = await prisma.$queryRawUnsafe<PlanRow[]>(statement, ...params);
  const elapsed = performance.now() - started;
  const plan = rows.map((row) => row["QUERY PLAN"]).join("\n");

  console.log(`\n## ${label}\n`);
  console.log(plan);

  const seqScan = /Seq Scan/.test(plan);
  const sort = /Sort Method|Sort\s+\(/.test(plan);
  console.log(
    `\nwall clock (incl. round trip): ${elapsed.toFixed(1)} ms` +
      ` | sequential scan: ${seqScan ? "YES" : "no"}` +
      ` | explicit sort: ${sort ? "yes" : "no"}`,
  );
}

async function cleanup(): Promise<void> {
  await prisma.auditLogEntry.deleteMany({
    where: { metadata: { path: ["benchmark"], equals: MARKER } },
  });
}

async function main(): Promise<void> {
  try {
    await prisma.$connect();
    console.log(`Benchmarking audit queries against ${databaseUrl.replace(/:[^:@]*@/, ":***@")}`);
    console.log(`Seeding ${String(ROWS)} rows (target slice: ${String(TARGET_ROWS)})\n`);

    await cleanup();
    await seed();

    const windowStart = new Date(BASE_TIME + (ROWS - TARGET_ROWS) * STEP_MS);

    await explain(
      "actor filter — (actor_id, sequence)",
      "EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM audit_log_entries WHERE sequence >= $1::int AND actor_id = $2::uuid ORDER BY sequence ASC LIMIT 50",
      1,
      TARGET_ACTOR_ID,
    );
    await explain(
      "subject filter — (subject_id, sequence)",
      "EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM audit_log_entries WHERE sequence >= $1::int AND subject_id = $2::uuid ORDER BY sequence ASC LIMIT 50",
      1,
      TARGET_SUBJECT_ID,
    );
    await explain(
      "action filter — (action, sequence)",
      "EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM audit_log_entries WHERE sequence >= $1::int AND action = $2::text ORDER BY sequence ASC LIMIT 50",
      1,
      TARGET_ACTION,
    );
    await explain(
      "date range — (occurred_at, sequence)",
      "EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM audit_log_entries WHERE sequence >= $1::int AND occurred_at >= $2::timestamptz ORDER BY sequence ASC LIMIT 50",
      1,
      windowStart,
    );
    await explain(
      "keyset only — unique (sequence)",
      "EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM audit_log_entries WHERE sequence >= $1::int ORDER BY sequence ASC LIMIT 50",
      ROWS - 100,
    );
    await explain(
      "organisation metadata (known limitation: no index)",
      "EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM audit_log_entries WHERE sequence >= $1::int AND metadata->>'organizationId' = $2::text ORDER BY sequence ASC LIMIT 50",
      1,
      "no-such-organisation",
    );
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error("Benchmark failed:", error);
  process.exitCode = 1;
});
