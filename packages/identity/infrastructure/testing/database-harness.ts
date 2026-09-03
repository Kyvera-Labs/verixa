import { execFileSync } from "node:child_process";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { PrismaClient } from "@verixa/database";

/**
 * Provides a real Postgres for integration tests, by whichever route is
 * available, and reports honestly when neither is.
 *
 * Two strategies, in priority order:
 *
 * 1. **An already-running database** named by `TEST_DATABASE_URL`. Used by
 *    CI, where a Postgres service container is already up and migrated, and
 *    by anyone running `docker compose up postgres` locally. Fastest, since
 *    nothing has to start.
 * 2. **A Testcontainers-managed ephemeral container** (Issue 047), started on
 *    demand and destroyed afterwards. Requires a working Docker daemon.
 *
 * Neither available means database-backed tests skip — a fresh clone with no
 * Docker still gets a green `pnpm test`. `REQUIRE_DATABASE_TESTS=1` converts
 * that skip into a failure so CI can't quietly lose the coverage.
 *
 * ### Why both, rather than only Testcontainers
 *
 * Testcontainers gives stronger isolation: every run gets a pristine
 * database, so tests cannot leak state into each other and a corrupted local
 * database can't produce failures that reproduce nowhere else. That's the
 * better default for correctness.
 *
 * It also costs a container start — image pull on a cold cache, then
 * initdb — on every run, and it requires Docker, which the CI job already
 * solves more cheaply with a service container that starts once for the whole
 * job. Preferring an existing database when one is offered keeps CI fast
 * without giving up the isolation guarantee for everyone else.
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
 * Applies the migration history to a freshly-started container.
 *
 * `migrate deploy`, not `db push`. `db push` would be faster — it derives the
 * schema straight from schema.prisma and skips migration files entirely — and
 * that is exactly why it's wrong here: it would test a schema that no
 * migration ever produced, so a broken or missing migration would still pass.
 * Replaying real migrations means these tests exercise the same schema
 * production will get.
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
 * Resolves a usable test database, or `undefined` when none can be obtained.
 * Throws instead of returning `undefined` when `REQUIRE_DATABASE_TESTS=1`.
 */
export async function startTestDatabase(): Promise<TestDatabase | undefined> {
  const required = process.env["REQUIRE_DATABASE_TESTS"] === "1";

  const existing = await existingDatabaseUrl();
  if (existing !== undefined) {
    const prisma = new PrismaClient({ datasources: { db: { url: existing } } });
    return {
      url: existing,
      prisma,
      stop: async () => {
        await prisma.$disconnect();
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

  const prisma = new PrismaClient({ datasources: { db: { url } } });
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
