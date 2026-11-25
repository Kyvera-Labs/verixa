import { describe, expect, it } from "vitest";

import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  paginate,
  paginatePages,
  type Page,
  type PageRequest,
} from "./pagination.js";

function fakeFetcher<T>(pages: readonly Page<T>[]): {
  fetchPage: (request: PageRequest) => Promise<Page<T>>;
  requests: PageRequest[];
} {
  const remaining = [...pages];
  const requests: PageRequest[] = [];

  return {
    requests,
    fetchPage: (request) => {
      requests.push(request);
      const page = remaining.shift();
      if (page === undefined) return Promise.reject(new Error("unexpected page fetch"));
      return Promise.resolve(page);
    },
  };
}

async function collect<T>(iterator: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterator) items.push(item);
  return items;
}

describe("paginate", () => {
  it("fetches nothing until the consumer asks for the first item", async () => {
    const { fetchPage, requests } = fakeFetcher([
      { items: ["first"], nextCursor: null, hasMore: false },
    ]);

    const iterator = paginate(fetchPage);
    expect(requests).toEqual([]);

    const result = await iterator.next();
    expect(result.value).toBe("first");
    expect(requests).toEqual([{ limit: DEFAULT_PAGE_LIMIT }]);
  });

  it("yields every item from every page in order", async () => {
    const { fetchPage, requests } = fakeFetcher([
      { items: ["a", "b"], nextCursor: "page-2", hasMore: true },
      { items: ["c"], nextCursor: null, hasMore: false },
    ]);

    const items = await collect(paginate(fetchPage));

    expect(items).toEqual(["a", "b", "c"]);
    expect(requests).toEqual([{ limit: 50 }, { cursor: "page-2", limit: 50 }]);
  });

  it("does not fetch the next page after the consumer breaks early", async () => {
    const { fetchPage, requests } = fakeFetcher([
      { items: ["a", "b"], nextCursor: "page-2", hasMore: true },
      { items: ["c"], nextCursor: null, hasMore: false },
    ]);

    const seen: string[] = [];
    for await (const item of paginate(fetchPage)) {
      seen.push(item);
      break;
    }

    expect(seen).toEqual(["a"]);
    expect(requests).toEqual([{ limit: 50 }]);
  });

  it("completes an empty result set without fetching another page", async () => {
    const { fetchPage, requests } = fakeFetcher([{ items: [], nextCursor: null, hasMore: false }]);

    const items = await collect(paginate(fetchPage));

    expect(items).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  it("stops when a server claims more pages but supplies no cursor", async () => {
    const { fetchPage, requests } = fakeFetcher([
      { items: ["a"], nextCursor: null, hasMore: true },
      { items: ["b"], nextCursor: null, hasMore: false },
    ]);

    const items = await collect(paginate(fetchPage));

    expect(items).toEqual(["a"]);
    expect(requests).toHaveLength(1);
  });

  it("stops when a server repeats a cursor instead of looping forever", async () => {
    const { fetchPage, requests } = fakeFetcher([
      { items: ["a"], nextCursor: "same", hasMore: true },
      { items: ["b"], nextCursor: "same", hasMore: true },
    ]);

    const items = await collect(paginate(fetchPage));

    expect(items).toEqual(["a", "b"]);
    expect(requests).toHaveLength(2);
  });

  it("clamps the page size and honours a resume cursor", async () => {
    const { fetchPage, requests } = fakeFetcher([
      { items: ["a"], nextCursor: null, hasMore: false },
    ]);

    await collect(paginate(fetchPage, { cursor: "resume", limit: MAX_PAGE_LIMIT + 10 }));

    expect(requests).toEqual([{ cursor: "resume", limit: MAX_PAGE_LIMIT }]);
  });

  it("clamps an invalid page size to the minimum", async () => {
    const { fetchPage, requests } = fakeFetcher([{ items: [], nextCursor: null, hasMore: false }]);

    await collect(paginate(fetchPage, { limit: 0 }));

    expect(requests).toEqual([{ limit: 1 }]);
  });
});

describe("paginatePages", () => {
  it("yields whole page envelopes without flattening them", async () => {
    const page: Page<number> = { items: [1, 2], nextCursor: null, hasMore: false };
    const { fetchPage } = fakeFetcher([page]);

    const pages = await collect(paginatePages(fetchPage));

    expect(pages).toEqual([page]);
  });
});
