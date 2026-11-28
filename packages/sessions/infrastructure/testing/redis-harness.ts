import { execFileSync } from "node:child_process";
import { createConnection } from "node:net";

import { Redis } from "ioredis";
import { GenericContainer, type StartedTestContainer } from "testcontainers";

/**
 * Provides a real Redis for integration tests:
 *
 * 1. The instance named by `TEST_REDIS_URL` (CI's service container or a local `docker compose up
 *    redis`).
 * 2. Otherwise an ephemeral Testcontainers `redis:7-alpine`, if Docker is available.
 *
 * With neither, Redis tests skip, unless `REQUIRE_REDIS_TESTS=1` makes that a failure.
 */

const CONNECT_TIMEOUT_MS = 2000;
const CONTAINER_START_TIMEOUT_MS = 120_000;
const REDIS_IMAGE = "redis:7-alpine";
const REDIS_PORT = 6379;

export interface TestRedis {
  readonly url: string;
  readonly client: Redis;
  /** Releases the client and, if this harness started one, the container. */
  readonly stop: () => Promise<void>;
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const finish = (result: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
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

async function existingRedisUrl(): Promise<string | undefined> {
  const configured = process.env["TEST_REDIS_URL"];
  if (configured === undefined) {
    return undefined;
  }

  const url = new URL(configured);
  const reachable = await canConnect(url.hostname, Number(url.port || REDIS_PORT));
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

function connect(url: string): Redis {
  const client = new Redis(url, {
    // Logical database 2 is this suite's alone (sessions revocation list); see the other
    // Redis harnesses. Parallel suites must not clear each other's keys.
    db: 2,
    maxRetriesPerRequest: 1,
    lazyConnect: false,
  });
  // ioredis emits 'error' on connection trouble; without a listener Node treats
  // it as an unhandled error and can tear the process down. Tests attach their
  // own handling where they exercise failure; this keeps the happy path quiet.
  client.on("error", () => {
    /* surfaced through the awaited command instead */
  });
  return client;
}

/**
 * Resolves a usable test Redis, or `undefined` when none can be obtained.
 * Throws instead of returning `undefined` when `REQUIRE_REDIS_TESTS=1`.
 */
export async function startTestRedis(): Promise<TestRedis | undefined> {
  const required = process.env["REQUIRE_REDIS_TESTS"] === "1";

  const existing = await existingRedisUrl();
  if (existing !== undefined) {
    const client = connect(existing);
    return {
      url: existing,
      client,
      stop: () => {
        // We did not start this Redis (it was handed to us via TEST_REDIS_URL),
        // so we only drop our own connection; there is no container to stop.
        client.disconnect();
        return Promise.resolve();
      },
    };
  }

  if (!dockerAvailable()) {
    if (required) {
      throw new Error(
        "REQUIRE_REDIS_TESTS=1 but no Redis is available: TEST_REDIS_URL is unset or unreachable, " +
          "and no Docker daemon was found for Testcontainers to use.",
      );
    }
    return undefined;
  }

  let container: StartedTestContainer | undefined;
  try {
    container = await new GenericContainer(REDIS_IMAGE)
      .withExposedPorts(REDIS_PORT)
      .withStartupTimeout(CONTAINER_START_TIMEOUT_MS)
      .start();
  } catch (error) {
    if (required) {
      throw error;
    }
    return undefined;
  }

  const url = `redis://${container.getHost()}:${String(container.getMappedPort(REDIS_PORT))}`;
  const client = connect(url);
  const started = container;

  return {
    url,
    client,
    stop: async () => {
      client.disconnect();
      await started.stop();
    },
  };
}
