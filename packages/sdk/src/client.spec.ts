import { describe, expect, it, vi } from "vitest";

import { VerixaClient } from "./client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("VerixaClient", () => {
  it("builds the request URL from the base URL and query params", async () => {
    const fetchMock = vi.fn<(input: unknown, init?: unknown) => Promise<Response>>(() =>
      Promise.resolve(jsonResponse({ ok: true })),
    );
    const client = new VerixaClient({
      baseUrl: "https://api.example.com/",
      fetch: fetchMock,
    });

    const result = await client.get<{ ok: boolean }>("/v1/audit", {
      actorId: "usr_1",
      cursor: undefined,
      limit: "10",
    });

    expect(result).toEqual({ ok: true });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://api.example.com/v1/audit?actorId=usr_1&limit=10",
    );
  });

  it("surfaces the status and response body when a request fails", async () => {
    const fetchMock = vi.fn<(input: unknown, init?: unknown) => Promise<Response>>(() =>
      Promise.resolve(jsonResponse({ error: "nope" }, 403)),
    );
    const client = new VerixaClient({
      baseUrl: "https://api.example.com",
      fetch: fetchMock,
    });

    await expect(client.get("/v1/audit")).rejects.toThrow("403");
  });
});
