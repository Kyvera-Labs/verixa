import { describe, expect, it } from "vitest";

import { canConnect } from "./helpers/tcp-connect.js";

const DEFAULT_TEST_DATABASE_URL = "postgres://verixa:verixa@localhost:5432/verixa_test";

describe("Postgres connectivity (Issue 041)", () => {
  it("accepts a TCP connection on the test database", async () => {
    const url = new URL(process.env["TEST_DATABASE_URL"] ?? DEFAULT_TEST_DATABASE_URL);
    const port = Number(url.port || 5432);

    await expect(canConnect(url.hostname, port)).resolves.toBe(true);
  });
});
