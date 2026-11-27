import { randomUUID } from "node:crypto";

import { createPrismaClient } from "@verixa/database";
import { Result } from "@verixa/shared-kernel";

import { User, type UserId } from "../domain/entities/user.js";
import { DisplayName } from "../domain/value-objects/display-name.js";
import { Email } from "../domain/value-objects/email.js";
import { PrismaUserRepository } from "../infrastructure/persistence/prisma-user-repository.js";

/**
 * Measures p50 and p95 latency of the core repository operations (`pnpm db:benchmark`) to give
 * later optimization a baseline. p95 shows the slow tail an average hides. Results are dominated by
 * the Postgres round trip, so they are only comparable on the same hardware, measured the same way.
 */

const ITERATIONS = Number(process.env["BENCH_ITERATIONS"] ?? 200);
const WARMUP = Number(process.env["BENCH_WARMUP"] ?? 20);

interface Measurement {
  readonly operation: string;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly min: number;
  readonly max: number;
}

function percentile(sortedMs: number[], p: number): number {
  if (sortedMs.length === 0) return 0;
  // Nearest-rank: the smallest value at or above the given percentile. Simple
  // and honest about being an estimate at these sample sizes — interpolating
  // between samples would imply a precision 200 iterations do not support.
  const rank = Math.ceil((p / 100) * sortedMs.length);
  const index = Math.min(Math.max(rank - 1, 0), sortedMs.length - 1);
  // `.at()` rather than `sortedMs[index]`: bracket access with a computed
  // index trips security/detect-object-injection, and restructuring beats
  // suppressing the rule.
  return sortedMs.at(index) ?? 0;
}

async function measure(
  operation: string,
  run: (i: number) => Promise<unknown>,
): Promise<Measurement> {
  // Warm-up runs are discarded. The first few calls pay for connection
  // establishment, Prisma's query-engine startup, and a cold buffer cache —
  // costs that are real but one-off, and that would otherwise dominate the
  // max and distort p95.
  for (let i = 0; i < WARMUP; i += 1) {
    await run(-1 - i);
  }

  const samples: number[] = [];
  for (let i = 0; i < ITERATIONS; i += 1) {
    const started = performance.now();
    await run(i);
    samples.push(performance.now() - started);
  }

  samples.sort((a, b) => a - b);
  return {
    operation,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
    min: samples[0] ?? 0,
    max: samples[samples.length - 1] ?? 0,
  };
}

function makeUser(seed: string): User {
  const email = Email.create(`bench-${seed}@example.com`);
  const displayName = DisplayName.create("Bench User");
  if (!Result.isOk(email) || !Result.isOk(displayName)) {
    throw new Error("benchmark fixture setup failed");
  }
  return User.register({ email: email.value, displayName: displayName.value });
}

async function main(): Promise<void> {
  const databaseUrl =
    process.env["DATABASE_URL"] ?? "postgres://verixa:verixa@localhost:5432/verixa";
  const prisma = createPrismaClient(databaseUrl);
  const users = new PrismaUserRepository(prisma);

  const seeded: User[] = [];
  const results: Measurement[] = [];

  try {
    await prisma.$connect();

    console.log(`Benchmarking against ${databaseUrl.replace(/:[^:@]*@/, ":***@")}`);
    console.log(`${String(ITERATIONS)} iterations, ${String(WARMUP)} warm-up\n`);

    results.push(
      await measure("UserRepository.save (insert)", async (i) => {
        const user = makeUser(`${randomUUID()}-${String(i)}`);
        await users.save(user);
        if (i >= 0) seeded.push(user);
      }),
    );

    if (seeded.length === 0) throw new Error("no users were seeded");

    results.push(
      await measure("UserRepository.findById", async (i) => {
        const user = seeded[Math.abs(i) % seeded.length];
        return users.findById(user?.id as UserId);
      }),
    );

    results.push(
      await measure("UserRepository.findByEmail", async (i) => {
        const user = seeded[Math.abs(i) % seeded.length];
        if (user === undefined) return undefined;
        return users.findByEmail(user.email);
      }),
    );

    results.push(
      await measure("UserRepository.existsByEmail", async (i) => {
        const user = seeded[Math.abs(i) % seeded.length];
        if (user === undefined) return false;
        return users.existsByEmail(user.email);
      }),
    );

    results.push(
      await measure("UserRepository.save (update)", async (i) => {
        const user = seeded[Math.abs(i) % seeded.length];
        if (user === undefined) return;
        await users.save(user);
      }),
    );

    console.log("| Operation | p50 (ms) | p95 (ms) | p99 (ms) | min | max |");
    console.log("| --- | ---: | ---: | ---: | ---: | ---: |");
    for (const r of results) {
      console.log(
        `| ${r.operation} | ${r.p50.toFixed(2)} | ${r.p95.toFixed(2)} | ` +
          `${r.p99.toFixed(2)} | ${r.min.toFixed(2)} | ${r.max.toFixed(2)} |`,
      );
    }
  } finally {
    if (seeded.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: seeded.map((u) => u.id) } } });
    }
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error("Benchmark failed:", error);
  process.exitCode = 1;
});
