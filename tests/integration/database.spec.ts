import { describe, expect, it } from "vitest";

import { databaseAvailability, testDatabaseUrl } from "./helpers/database.js";

const available = await databaseAvailability();

describe("Postgres connectivity (Issue 041)", () => {
  it.skipIf(!available)("accepts a TCP connection on the test database", () => {
    // `available` is itself the result of the connection attempt, so reaching
    // an unskipped run of this test is the assertion.
    expect(available).toBe(true);
    expect(() => new URL(testDatabaseUrl())).not.toThrow();
  });
});
