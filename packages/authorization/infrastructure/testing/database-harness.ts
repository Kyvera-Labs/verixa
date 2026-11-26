import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createPrismaClient, type PrismaClient } from "@verixa/database";

const CONNECT_TIMEOUT_MS = 2_000;
const CONTAINER_START_TIMEOUT_MS = 120_000;

export interface TestDatabase {
  readonly prisma: PrismaClient;
  readonly stop: () => Promise<void>;
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolveConnection) => {
    const socket = createConnection({ host, port });
    const finish = (reachable: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolveConnection(reachable);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => finish(false));
  });
}

async function existingDatabaseUrl(): Promise<string | undefined> {
  const configured = process.env["TEST_DATABASE_URL"];
  if (configured === undefined) return undefined;
  const url = new URL(configured);
  return (await canConnect(url.hostname, Number(url.port || 5432))) ? configured : undefined;
}

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

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
  const name = `verixa_authz_it_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
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

export async function startTestDatabase(): Promise<TestDatabase | undefined> {
  const required = process.env["REQUIRE_DATABASE_TESTS"] === "1";
  const existing = await existingDatabaseUrl();
  if (existing !== undefined) {
    const scratch = await createScratchDatabase(existing);
    const prisma = createPrismaClient(scratch.url);
    return {
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

  let container: StartedPostgreSqlContainer;
  try {
    container = await new PostgreSqlContainer("postgres:16-alpine")
      .withDatabase("verixa_test")
      .withUsername("verixa")
      .withPassword("verixa")
      .withStartupTimeout(CONTAINER_START_TIMEOUT_MS)
      .start();
  } catch (error) {
    if (required) throw error;
    return undefined;
  }

  const url = container.getConnectionUri();
  try {
    applyMigrations(url);
  } catch (error) {
    await container.stop();
    throw error;
  }

  const prisma = createPrismaClient(url);
  return {
    prisma,
    stop: async () => {
      await prisma.$disconnect();
      await container.stop();
    },
  };
}
