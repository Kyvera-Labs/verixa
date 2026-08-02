import { afterEach, describe, expect, it } from "vitest";

import { createHttpTestClient, type HttpTestClient } from "./helpers/http-client.js";

describe("GET /health", () => {
  let client: HttpTestClient | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it("responds with 200 and the expected body over real HTTP", async () => {
    client = await createHttpTestClient();

    const response = await client.request.get("/health");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.body).toEqual({ status: "ok" });
  });
});
