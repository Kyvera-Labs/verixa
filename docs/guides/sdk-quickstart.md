# SDK quickstart

The TypeScript SDK lives in `packages/sdk` and is published to workspace
consumers as `@verixa/sdk`. It is deliberately thin: resource clients own paths
and request shapes, while the shared helpers own the parts every collection
needs — following cursors and building query params. Authentication, typed
errors, and generated types belong to their own roadmap issues, so this guide
covers the pagination and filtering surface available today.

```ts
import { VerixaClient, auditFilters } from "@verixa/sdk";

const client = new VerixaClient({ baseUrl: "http://localhost:3000" });
```

## Pagination

Verixa list endpoints use keyset cursors and return the same envelope:
`{ items, nextCursor, hasMore }`. The SDK turns that envelope into an
`AsyncIterableIterator`, so a whole result set looks like one loop:

```ts
for await (const event of client.audit.queryEvents({ limit: 100 })) {
  console.log(event.action);
}
```

The same helper backs the identity collection:

```ts
for await (const user of client.identity.listUsers()) {
  console.log(user.email);
}
```

Three properties are worth naming explicitly:

- **Lazy:** constructing the iterator does not issue a request. The first page
  is fetched when the first item is requested, and page _N+1_ is fetched only
  after page _N_ has been consumed. Walking 10,000 records with an early exit
  never allocates all 10,000 in an array.
- **Early exit:** `break`, `return`, or an exception from the loop calls the
  generator's `return()` hook. No further page is fetched. This is why the
  helper is an async generator rather than a `Promise<T[]>` with an optional
  `maxPages` argument — the latter would have to fetch everything before the
  caller could decide to stop.
- **Empty sets:** an empty first page completes after one request and yields
  nothing. There is no sentinel page and no off-by-one retry.

If the server reports `hasMore: true` but omits `nextCursor`, returns an empty
page, or repeats a cursor, iteration stops. Those responses cannot make
forward progress; throwing would turn a malformed page into a fatal error for a
read-only scan, while continuing would spin on the same request forever.

`paginatePages` is available when a caller needs the envelope itself (for
example, to record the last cursor for a later resume). `paginate` flattens
those pages into items and is the normal choice.

```ts
import { paginate, paginatePages } from "@verixa/sdk";

const items = paginate(fetchPage, { cursor: savedCursor, limit: 25 });
const pages = paginatePages(fetchPage, { limit: 25 });
```

`limit` is clamped to the API's 1–100 range. Both helpers accept a `PageFetcher`
— a function from `{ cursor?, limit }` to a page — so they can wrap any
cursor-based endpoint without importing a transport. A rejected alternative was
passing a URL into the iterator: that would make the helper responsible for
paths and query encoding, and every new endpoint would need a special case.

## Filtering

`auditFilters()` exposes only the parameters documented for `GET /v1/audit`
in `apps/api/openapi/openapi.yaml`: `actorId`, `subjectId`, `from`, and `to`.
The builder omits unset and blank values and serializes `Date` bounds to ISO
8601, matching the route's Zod query schema.

```ts
const filter = auditFilters().actorId("usr_123").from(new Date("2026-01-01T00:00:00Z")).build();

for await (const event of client.audit.queryEvents({ filter })) {
  console.log(event.id);
}
```

The same filter object is sent on every page. Dropping it after page one would
quietly widen the scan to unrelated actors and time ranges — a bug that is
easy to miss because each individual page still looks valid.

`QueryParamsBuilder` is the shared primitive for new resources. `sortParams`
builds sort params with names supplied by the caller:

```ts
sortParams({ field: "createdAt", direction: "desc" }, { field: "sort", direction: "order" });
// { sort: "createdAt", order: "desc" }
```

No current REST endpoint documents sort parameters, so no resource calls this
helper yet. Global `sortBy`/`sortOrder` constants were rejected: strict query
validation would reject them on endpoints that do not support sorting.
