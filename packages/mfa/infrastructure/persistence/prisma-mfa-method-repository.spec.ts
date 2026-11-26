import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createPrismaClient, type PrismaClient } from "@verixa/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MfaMethod, type UserId } from "../../domain/entities/mfa-method.js";
import { mfaMethodRepositoryContract } from "../testing/contracts/mfa-method-repository.contract.js";

import { PrismaMfaMethodRepository } from "./prisma-mfa-method-repository.js";

/**
 * Database-backed tests skip when no Postgres is reachable, so a fresh clone
 * without Docker still gets a green `pnpm test`; `TEST_DATABASE_URL` points at
 * one that is already running (CI service container or `docker compose up
 * postgres`). Mirrors the harness used by `@verixa/identity`.
 */
async function databaseUrl(): Promise<string | undefined> {
  const configured = process.env["TEST_DATABASE_URL"];
  if (configured === undefined) return undefined;

  const url = new URL(configured);
  const reachable = await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: url.hostname, port: Number(url.port || 5432) });
    const finish = (result: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(2_000, () => finish(false));
  });

  return reachable ? configured : undefined;
}

const database = await databaseUrl();

/**
 * This file runs against a scratch database of its own, created in `beforeAll`
 * and dropped in `afterAll`, for the same reason as
 * `packages/sessions/infrastructure/testing/prisma-session-repository.spec.ts`:
 * `pnpm -r run test` runs packages concurrently, and the identity, credentials
 * and verification suites call `user.deleteMany({})` between tests. On the
 * shared database that wiped this file's fixture users mid-test, so saves
 * failed with "MfaMethod references a record that does not exist".
 */
function scratchDatabaseName(): string {
  return `verixa_mfa_it_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

function urlForDatabase(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

/** `migrate deploy` so the tests exercise the schema the migrations really produce. */
function applyMigrations(databaseUrl: string): void {
  const databasePackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../database");
  execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
    cwd: databasePackageRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "ignore",
    shell: process.platform === "win32",
  });
}

describe.skipIf(database === undefined)("PrismaMfaMethodRepository (real Postgres)", () => {
  // The client is created in `beforeAll`, not eagerly: Vitest still executes a
  // skipped suite's body to collect its tests, so constructing `PrismaClient`
  // here would throw on an undefined datasource URL even when no database is
  // configured — turning the intended skip into a red `pnpm test` on a machine
  // without Docker. Mirrors `@verixa/identity`'s harness.
  let prisma: PrismaClient;
  let databaseName: string;

  beforeAll(async () => {
    // The repository encrypts secrets on the way in, and `encrypt` refuses to
    // run without a key rather than falling back to a constant one. The value
    // is irrelevant here as long as it is a valid 32-byte AES-256 key.
    process.env["MFA_ENCRYPTION_KEY"] ??= Buffer.alloc(32, 7).toString("base64");

    databaseName = scratchDatabaseName();
    const admin = createPrismaClient(database as string);
    try {
      // DDL: Postgres cannot bind a database name. `databaseName` comes only from
      // `scratchDatabaseName()` (fixed prefix, pid, random hex), never from input.
      // eslint-disable-next-line no-restricted-syntax
      await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
    } finally {
      await admin.$disconnect();
    }
    const scratchUrl = urlForDatabase(database as string, databaseName);
    applyMigrations(scratchUrl);
    prisma = createPrismaClient(scratchUrl);
    await prisma.$connect();
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect();
    const admin = createPrismaClient(database as string);
    try {
      // eslint-disable-next-line no-restricted-syntax
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    } finally {
      await admin.$disconnect();
    }
  }, 120_000);

  async function setupUser(): Promise<UserId> {
    const id = randomUUID();
    const now = new Date();
    await prisma.user.create({
      data: {
        id,
        email: `mfa-${id}@example.com`,
        displayName: "MFA Test User",
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
    });
    return id as UserId;
  }

  mfaMethodRepositoryContract(() => new PrismaMfaMethodRepository(prisma), setupUser);

  describe("encryption at rest", () => {
    it("stores the TOTP secret encrypted, and decrypts it on read", async () => {
      const repository = new PrismaMfaMethodRepository(prisma);
      const userId = await setupUser();

      const plaintext = "my-super-secret-totp";
      const method = MfaMethod.create(userId, "totp", plaintext);
      await repository.save(method);

      const rawRow = await prisma.mfaMethod.findUnique({ where: { id: method.id } });
      expect(rawRow?.secret).not.toBeNull();
      expect(rawRow?.secret).not.toBe(plaintext);
      expect(rawRow?.secret).not.toContain(plaintext);

      const fetched = await repository.findById(method.id);
      expect(fetched?.secret).toBe(plaintext);
    });
  });
});
