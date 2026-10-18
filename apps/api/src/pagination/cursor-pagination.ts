import { z } from "zod";

/**
 * Standard pagination query parameters for cursor-based pagination.
 */
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;
export const MIN_PAGE_LIMIT = 1;

export interface CursorPayload {
  readonly id: string;
  readonly createdAt: string;
}

export interface CursorPaginationParams {
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface PaginatedResult<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/**
 * Encodes an opaque keyset cursor (base64 JSON).
 */
export function encodeCursor(payload: { id: string; createdAt: Date | string }): string {
  const createdAtStr =
    payload.createdAt instanceof Date ? payload.createdAt.toISOString() : payload.createdAt;
  const jsonStr = JSON.stringify({ id: payload.id, createdAt: createdAtStr });
  return Buffer.from(jsonStr, "utf8").toString("base64url");
}

/**
 * Decodes an opaque keyset cursor. Returns null if cursor is invalid or malformed.
 */
export function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "id" in parsed &&
      typeof (parsed as Record<string, unknown>).id === "string" &&
      "createdAt" in parsed &&
      typeof (parsed as Record<string, unknown>).createdAt === "string"
    ) {
      return {
        id: (parsed as Record<string, unknown>).id as string,
        createdAt: (parsed as Record<string, unknown>).createdAt as string,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Clamps and sanitizes limit within [MIN_PAGE_LIMIT, MAX_PAGE_LIMIT].
 */
export function sanitizeLimit(
  limit: number | string | null | undefined,
  defaultLimit: number = DEFAULT_PAGE_LIMIT,
  maxLimit: number = MAX_PAGE_LIMIT,
): number {
  if (limit === undefined || limit === null || limit === "") {
    return defaultLimit;
  }
  const parsed = typeof limit === "string" ? Number.parseInt(limit, 10) : Math.trunc(limit);
  if (Number.isNaN(parsed) || parsed < MIN_PAGE_LIMIT) {
    return MIN_PAGE_LIMIT;
  }
  if (parsed > maxLimit) {
    return maxLimit;
  }
  return parsed;
}

/**
 * Zod schema for cursor pagination query string.
 */
export const cursorPaginationQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce
    .number()
    .int()
    .min(MIN_PAGE_LIMIT)
    .max(MAX_PAGE_LIMIT)
    .default(DEFAULT_PAGE_LIMIT),
});

/**
 * Creates standard paginated envelope: { items, nextCursor, hasMore }
 */
export function paginateEnvelope<T extends { id: string; createdAt: Date | string }>(
  itemsWithExtra: readonly T[],
  limit: number,
): PaginatedResult<T> {
  const hasMore = itemsWithExtra.length > limit;
  const items = hasMore ? itemsWithExtra.slice(0, limit) : itemsWithExtra;
  const lastItem = items.length > 0 ? items[items.length - 1] : undefined;
  const nextCursor = hasMore && lastItem ? encodeCursor(lastItem) : null;

  return {
    items,
    nextCursor,
    hasMore,
  };
}
