import { Redis } from "ioredis";

/** A Redis client the spec below owns, plus the teardown that stops it. */
export interface TestRedis {
  readonly client: Redis;
  readonly stop: () => Promise<void>;
}

/**
 * Connects to the Redis named by `TEST_REDIS_URL`, or returns `undefined` so the suite skips
 * locally. CI sets the variable and `REQUIRE_REDIS_TESTS=1`, which turns a missing Redis into a
 * failure.
 */
export async function startTestRedis(): Promise<TestRedis | undefined> {
  const url = process.env.TEST_REDIS_URL;
  if (url === undefined || url.trim() === "") {
    if (process.env.REQUIRE_REDIS_TESTS === "1") {
      throw new Error(
        "REQUIRE_REDIS_TESTS=1 but TEST_REDIS_URL is not set — the Redis-backed cache suite would have skipped.",
      );
    }
    return undefined;
  }

  const client = new Redis(url, {
    // Logical database 1 is this suite's alone (authorization policy cache). Packages run their
    // tests in parallel against one Redis, and a suite that clears its keys
    // between tests must never clear another suite's.
    db: 1,
    // Fail fast rather than buffering commands behind a connection that may
    // never arrive: a test that hangs is worse than a test that fails.
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 2,
    retryStrategy: () => null,
  });
  client.on("error", () => {
    /* handled by the ping below */
  });

  try {
    await client.connect();
    await client.ping();
  } catch (error) {
    client.disconnect();
    if (process.env.REQUIRE_REDIS_TESTS === "1") {
      throw new Error(`REQUIRE_REDIS_TESTS=1 but ${url} is unreachable: ${String(error)}`, {
        cause: error,
      });
    }
    return undefined;
  }

  return {
    client,
    stop: () => {
      client.disconnect();
      return Promise.resolve();
    },
  };
}
