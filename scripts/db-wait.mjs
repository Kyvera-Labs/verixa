#!/usr/bin/env node
// Waits until Postgres itself answers, or gives up. Dependency-free. A TCP connect is not enough,
// because Docker's published-port proxy accepts connections before Postgres is listening, so each
// attempt sends the 8-byte SSLRequest and waits for the server's one-byte reply (`S` or `N`).
//
// Usage: node scripts/db-wait.mjs [connectionUrl] (falls back to DATABASE_URL, then the local
// default).

import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const DEFAULT_URL = "postgres://verixa:verixa@localhost:5432/verixa";
const MAX_ATTEMPTS = 30;
const RETRY_DELAY_MS = 1000;
const CONNECT_TIMEOUT_MS = 2000;

// Int32 length (8) followed by the SSLRequest code 80877103.
const SSL_REQUEST = Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]);

/**
 * Resolves true when a Postgres server at host:port answers an SSLRequest,
 * false on refusal, hang-up, timeout or any other reply.
 */
export function postgresAnswers(host, port, timeoutMs = CONNECT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const finish = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => socket.write(SSL_REQUEST));
    socket.once("data", (reply) => finish(reply[0] === 0x53 || reply[0] === 0x4e));
    socket.once("end", () => finish(false));
    socket.once("close", () => finish(false));
    socket.once("error", () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

async function main() {
  const target = process.argv[2] ?? process.env["DATABASE_URL"] ?? DEFAULT_URL;
  const { hostname: host, port: rawPort } = new URL(target);
  const port = Number(rawPort || 5432);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- intentionally sequential: each attempt must finish before the next.
    if (await postgresAnswers(host, port)) {
      console.log(`Postgres is accepting connections at ${host}:${port}.`);
      process.exit(0);
    }
    console.log(`Waiting for Postgres at ${host}:${port} (attempt ${attempt}/${MAX_ATTEMPTS})...`);
    // eslint-disable-next-line no-await-in-loop -- see above.
    await delay(RETRY_DELAY_MS);
  }

  console.error(`Postgres at ${host}:${port} did not become reachable in time.`);
  process.exit(1);
}

// Run only when executed directly, so tests can import postgresAnswers.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
