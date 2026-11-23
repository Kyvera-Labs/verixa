import { createConnection } from "node:net";

import { PrismaClient } from "@verixa/database";

const CONNECT_TIMEOUT_MS = 2_000;

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
  const configured =
    process.env["TEST_DATABASE_URL"] ?? "postgres://verixa:verixa@localhost:5432/verixa_test";
  try {
    const url = new URL(configured);
    const reachable = await canConnect(url.hostname, Number(url.port || 5432));
    return reachable ? configured : undefined;
  } catch {
    return undefined;
  }
}

export async function startTestDatabase(): Promise<TestDatabase | undefined> {
  const required = process.env["REQUIRE_DATABASE_TESTS"] === "1";
  const existing = await existingDatabaseUrl();
  if (existing !== undefined) {
    const prisma = new PrismaClient({ datasources: { db: { url: existing } } });
    return { prisma, stop: async () => prisma.$disconnect() };
  }

  if (required) {
    throw new Error("REQUIRE_DATABASE_TESTS=1 but TEST_DATABASE_URL is unreachable.");
  }
  return undefined;
}
