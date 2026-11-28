/**
 * The paginated envelope every Verixa cursor-based list endpoint returns.
 * `nextCursor` is `null` (not `undefined`) on the last page — that is the
 * server contract documented in `docs/guides/api-design.md`.
 */
export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/** The request shape a resource sends after the pagination helper resolves it. */
export interface PageRequest {
  readonly cursor?: string | undefined;
  readonly limit: number;
}

/**
 * A single page fetch. Resources supply this seam; the iterator only knows the
 * envelope protocol, so it can wrap any cursor-based endpoint without knowing
 * the path, headers, or transport.
 */
export type PageFetcher<T> = (request: PageRequest) => Promise<Page<T>>;

export interface PaginationOptions {
  /** Page size, clamped to the API's 1–100 range. Defaults to 50. */
  readonly limit?: number | undefined;
  /** Resume from a cursor returned by an earlier iteration. */
  readonly cursor?: string | undefined;
}

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;
const MIN_PAGE_LIMIT = 1;

function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_LIMIT;
  const resolved = Math.trunc(limit);
  if (!Number.isFinite(resolved) || resolved < MIN_PAGE_LIMIT) return MIN_PAGE_LIMIT;
  return Math.min(resolved, MAX_PAGE_LIMIT);
}

/**
 * Yields one page at a time, fetching only when the consumer asks for the next
 * page. Returning early from the generator (which is what `break` in a
 * `for await` does) leaves the next page unfetched.
 */
export async function* paginatePages<T>(
  fetchPage: PageFetcher<T>,
  options: PaginationOptions = {},
): AsyncIterableIterator<Page<T>> {
  const limit = resolveLimit(options.limit);
  const seenCursors = new Set<string>();
  let cursor = options.cursor;

  if (cursor !== undefined) seenCursors.add(cursor);

  for (;;) {
    const request: PageRequest = cursor === undefined ? { limit } : { cursor, limit };
    const page = await fetchPage(request);

    // The page is yielded before any decision about the next one. A consumer
    // that stops here never pays for another request.
    yield page;

    if (!page.hasMore) return;

    const nextCursor = page.nextCursor;
    // A server that says `hasMore` but omits the cursor, returns an empty page,
    // or repeats a cursor cannot make progress. Stop instead of spinning on the
    // same request forever; treating a malformed page as a hard error would
    // make a transient server bug fatal for a read-only iteration.
    if (
      nextCursor === null ||
      nextCursor === "" ||
      page.items.length === 0 ||
      seenCursors.has(nextCursor)
    ) {
      return;
    }

    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}

/**
 * Walks every page and yields items lazily; breaking out stops further page fetches.
 *
 * ```ts
 * for await (const event of client.audit.queryEvents()) {
 *   console.log(event.id);
 *   if (event.id === target) break;
 * }
 * ```
 */
export async function* paginate<T>(
  fetchPage: PageFetcher<T>,
  options: PaginationOptions = {},
): AsyncIterableIterator<T> {
  for await (const page of paginatePages(fetchPage, options)) {
    for (const item of page.items) yield item;
  }
}
