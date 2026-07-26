import { describe, expect, it, afterAll } from "vitest";
import supertest from "supertest";
import { buildApp } from "./app.js";

describe("GET /health", () => {
  const app = buildApp();

  afterAll(async () => {
    await app.close();
  });

  it("responds with 200 and status ok", async () => {
    await app.ready();
    const response = await supertest(app.server).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });
});
