#!/usr/bin/env node
// Polls a TCP connection to Postgres until it accepts one, or gives up.
// Deliberately dependency-free (no `pg` driver, no Prisma) — this only
// needs to answer "is anything listening on this host:port yet," which a
// raw socket connect proves without needing to speak the Postgres wire
// protocol. That's not the same as "Postgres has finished initializing and
// is ready to serve queries" (a container can accept TCP connections
// slightly before the database inside it is truly ready), but it's a good
// enough signal for local dev/CI startup ordering, and it's what
// docker-compose.yml's own `pg_isready` healthcheck backs up in practice.
//
// Usage: node scripts/db-wait.mjs [connectionUrl]
// Falls back to DATABASE_URL, then the local dev default.

import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_URL = "postgres://verixa:verixa@localhost:5432/verixa";
const MAX_ATTEMPTS = 30;
const RETRY_DELAY_MS = 1000;
const CONNECT_TIMEOUT_MS = 2000;

const target = process.argv[2] ?? process.env["DATABASE_URL"] ?? DEFAULT_URL;
const { hostname: host, port: rawPort } = new URL(target);
const port = Number(rawPort || 5432);

function canConnect() {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const finish = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => finish(false));
  });
}

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
  // eslint-disable-next-line no-await-in-loop -- intentionally sequential: each attempt must finish before the next.
  if (await canConnect()) {
    console.log(`Postgres is accepting connections at ${host}:${port}.`);
    process.exit(0);
  }
  console.log(`Waiting for Postgres at ${host}:${port} (attempt ${attempt}/${MAX_ATTEMPTS})...`);
  // eslint-disable-next-line no-await-in-loop -- see above.
  await delay(RETRY_DELAY_MS);
}

console.error(`Postgres at ${host}:${port} did not become reachable in time.`);
process.exit(1);
