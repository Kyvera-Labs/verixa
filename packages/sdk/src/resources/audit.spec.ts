import { describe, expect, it } from "vitest";

import type { RequestClient } from "../client.js";
import { auditFilters, type QueryParams } from "../filters.js";
import type { Page } from "../pagination.js";

import { AuditResource, type AuditEvent } from "./audit.js";

function event(id: string): AuditEvent {
  return {
    id,
    sequence: Number(id),
    action: "user.registered",
    actorId: "usr_1",
    subjectId: null,
    occurredAt: "2026-01-01T00:00:00.000Z",
    metadata: {},
  };
}

function fakeClient(pages: readonly Page<AuditEvent>[]): {
  client: RequestClient;
  requests: Array<{ path: string; query: QueryParams | undefined }>;
} {
  const remaining = [...pages];
  const requests: Array<{ path: string; query: QueryParams | undefined }> = [];

  return {
    requests,
    client: {
      get: <T>(path: string, query?: QueryParams): Promise<T> => {
        requests.push({ path, query });
        const page = remaining.shift();
        if (page === undefined) return Promise.reject(new Error("unexpected request"));
        return Promise.resolve(page as T);
      },
    },
  };
}

describe("AuditResource.queryEvents", () => {
  it("keeps the documented filters on every page of the iteration", async () => {
    const { client, requests } = fakeClient([
      { items: [event("1")], nextCursor: "page-2", hasMore: true },
      { items: [event("2")], nextCursor: null, hasMore: false },
    ]);
    const resource = new AuditResource(client);
    const filter = auditFilters().actorId("usr_1").build();

    const ids: string[] = [];
    for await (const item of resource.queryEvents({ filter, limit: 1 })) ids.push(item.id);

    expect(ids).toEqual(["1", "2"]);
    expect(requests).toEqual([
      { path: "/v1/audit", query: { actorId: "usr_1", limit: "1" } },
      { path: "/v1/audit", query: { actorId: "usr_1", cursor: "page-2", limit: "1" } },
    ]);
  });

  it("stops requesting pages when the consumer breaks", async () => {
    const { client, requests } = fakeClient([
      { items: [event("1")], nextCursor: "page-2", hasMore: true },
      { items: [event("2")], nextCursor: null, hasMore: false },
    ]);
    const resource = new AuditResource(client);

    for await (const item of resource.listEvents()) {
      expect(item.id).toBe("1");
      break;
    }

    expect(requests).toHaveLength(1);
  });
});
