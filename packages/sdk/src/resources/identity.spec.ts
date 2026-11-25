import { describe, expect, it } from "vitest";

import type { RequestClient } from "../client.js";
import type { QueryParams } from "../filters.js";
import type { Page } from "../pagination.js";

import { IdentityResource, type SdkUser } from "./identity.js";

function user(id: string): SdkUser {
  return { id, email: `${id}@example.com`, createdAt: "2026-01-01T00:00:00.000Z" };
}

describe("IdentityResource.listUsers", () => {
  it("walks the user collection with the configured path and cursor", async () => {
    const requests: Array<{ path: string; query: QueryParams | undefined }> = [];
    const pages: Array<Page<SdkUser>> = [
      { items: [user("1")], nextCursor: "next", hasMore: true },
      { items: [user("2")], nextCursor: null, hasMore: false },
    ];
    const client: RequestClient = {
      get: <T>(path: string, query?: QueryParams): Promise<T> => {
        requests.push({ path, query });
        return Promise.resolve(pages.shift() as T);
      },
    };
    const resource = new IdentityResource(client, { listUsersPath: "/v1/users" });

    const ids: string[] = [];
    for await (const item of resource.listUsers({ limit: 3 })) ids.push(item.id);

    expect(ids).toEqual(["1", "2"]);
    expect(requests).toEqual([
      { path: "/v1/users", query: { limit: "3" } },
      { path: "/v1/users", query: { cursor: "next", limit: "3" } },
    ]);
  });
});
