import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createPrismaClient, type PrismaClient } from "@verixa/database";

/**
 * Provides a real Postgres for integration tests:
 *
 * 1. With `TEST_DATABASE_URL` (CI's service container, or `docker compose up postgres` locally), a
 *    private scratch database is created from it, migrated, and dropped by `stop()`.
 * 2. Otherwise an ephemeral Testcontainers Postgres, if Docker is available.
 *
 * With neither, database tests skip, unless `REQUIRE_DATABASE_TESTS=1` makes that a failure.
 */

const CONNECT_TIMEOUT_MS = 2000;
const CONTAINER_START_TIMEOUT_MS = 120_000;

export interface TestDatabase {
  readonly url: string;
  readonly prisma: PrismaClient;
  /** Releases the client and, if this harness started one, the container. */
  readonly stop: () => Promise<void>;
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve_) => {
    const socket = createConnection({ host, port });
    const finish = (result: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve_(result);
    };
    socket.once("connect", () => {
      finish(true);
    });
    socket.once("error", () => {
      finish(false);
    });
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
      finish(false);
    });
  });
}

async function existingDatabaseUrl(): Promise<string | undefined> {
  const configured = process.env["TEST_DATABASE_URL"];
  if (configured === undefined) {
    return undefined;
  }

  const url = new URL(configured);
  const reachable = await canConnect(url.hostname, Number(url.port || 5432));
  return reachable ? configured : undefined;
}

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Applies the migration history with `migrate deploy`, not `db push`, so tests run against the
 * schema real migrations produce and a broken migration fails.
 */
function applyMigrations(databaseUrl: string): void {
  const databasePackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../database");

  execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
    cwd: databasePackageRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "ignore",
    shell: process.platform === "win32",
  });
}

/**
 * A private, migrated copy of the shared database, dropped by `drop()`.
 *
 * `pnpm -r test` runs packages concurrently, and several suites clear tables
 * between tests (`user.deleteMany({})`). On one shared database those clears
 * delete other suites' fixtures mid-test, which surfaced as foreign-key
 * failures and rows that vanished. So every caller gets a scratch database of
 * its own, as the mfa and sessions suites already do.
 */
async function createScratchDatabase(
  baseUrl: string,
): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `verixa_identity_it_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;

  // DDL: Postgres cannot bind a database name. `name` is built above from a
  // fixed prefix, the pid and random hex, never from input.
  const admin = createPrismaClient(baseUrl);
  try {
    // eslint-disable-next-line no-restricted-syntax
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.$disconnect();
  }

  const drop = async (): Promise<void> => {
    const dropper = createPrismaClient(baseUrl);
    try {
      // eslint-disable-next-line no-restricted-syntax
      await dropper.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } finally {
      await dropper.$disconnect();
    }
  };

  try {
    applyMigrations(url.toString());
  } catch (error) {
    await drop();
    throw error;
  }
  return { url: url.toString(), drop };
}

/**
 * Resolves a usable test database, or `undefined` when none can be obtained.
 * Throws instead of returning `undefined` when `REQUIRE_DATABASE_TESTS=1`.
 */
export async function startTestDatabase(): Promise<TestDatabase | undefined> {
  const required = process.env["REQUIRE_DATABASE_TESTS"] === "1";

  const existing = await existingDatabaseUrl();
  if (existing !== undefined) {
    const scratch = await createScratchDatabase(existing);
    const prisma = createPrismaClient(scratch.url);
    return {
      url: scratch.url,
      prisma,
      stop: async () => {
        await prisma.$disconnect();
        await scratch.drop();
      },
    };
  }

  if (!dockerAvailable()) {
    if (required) {
      throw new Error(
        "REQUIRE_DATABASE_TESTS=1 but no database is available: TEST_DATABASE_URL is unset or " +
          "unreachable, and no Docker daemon was found for Testcontainers to use.",
      );
    }
    return undefined;
  }

  // #region testcontainers
  let container: StartedPostgreSqlContainer | undefined;
  try {
    container = await new PostgreSqlContainer("postgres:16-alpine")
      .withDatabase("verixa_test")
      .withUsername("verixa")
      .withPassword("verixa")
      .withStartupTimeout(CONTAINER_START_TIMEOUT_MS)
      .start();
  } catch (error) {
    if (required) {
      throw error;
    }
    return undefined;
  }

  const url = container.getConnectionUri();
  applyMigrations(url);
  // #endregion testcontainers

  const prisma = createPrismaClient(url);
  const started = container;

  return {
    url,
    prisma,
    stop: async () => {
      await prisma.$disconnect();
      await started.stop();
    },
  };
}
