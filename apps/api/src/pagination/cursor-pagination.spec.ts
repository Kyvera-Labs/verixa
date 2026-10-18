import { describe, expect, it } from "vitest";

import {
  decodeCursor,
  DEFAULT_PAGE_LIMIT,
  encodeCursor,
  MAX_PAGE_LIMIT,
  MIN_PAGE_LIMIT,
  paginateEnvelope,
  sanitizeLimit,
} from "./cursor-pagination.js";

describe("cursor-based pagination", () => {
  it("encodes and decodes opaque cursor correctly", () => {
    const payload = {
      id: "usr_123456",
      createdAt: new Date("2026-01-15T12:00:00.000Z"),
    };

    const cursor = encodeCursor(payload);
    expect(typeof cursor).toBe("string");
    expect(cursor).not.toContain(" ");

    const decoded = decodeCursor(cursor);
    expect(decoded).toEqual({
      id: "usr_123456",
      createdAt: "2026-01-15T12:00:00.000Z",
    });
  });

  it("returns null when decoding a malformed cursor", () => {
    expect(decodeCursor("not-a-valid-cursor")).toBeNull();
    expect(decodeCursor(Buffer.from("invalid-json", "utf8").toString("base64url"))).toBeNull();
    expect(decodeCursor(Buffer.from(JSON.stringify({ other: 123 }), "utf8").toString("base64url"))).toBeNull();
  });

  it("sanitizes limit within bounds", () => {
    expect(sanitizeLimit(undefined)).toBe(DEFAULT_PAGE_LIMIT);
    expect(sanitizeLimit(null)).toBe(DEFAULT_PAGE_LIMIT);
    expect(sanitizeLimit("")).toBe(DEFAULT_PAGE_LIMIT);
    expect(sanitizeLimit(0)).toBe(MIN_PAGE_LIMIT);
    expect(sanitizeLimit(-10)).toBe(MIN_PAGE_LIMIT);
    expect(sanitizeLimit(500)).toBe(MAX_PAGE_LIMIT);
    expect(sanitizeLimit("25")).toBe(25);
    expect(sanitizeLimit("abc")).toBe(MIN_PAGE_LIMIT);
  });

  it("builds standard pagination envelope when more items exist", () => {
    const items = [
      { id: "1", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "2", createdAt: "2026-01-02T00:00:00.000Z" },
      { id: "3", createdAt: "2026-01-03T00:00:00.000Z" },
    ];
    // Asking for limit 2 with 3 items received indicates hasMore: true
    const result = paginateEnvelope(items, 2);
    expect(result.items).toHaveLength(2);
    expect(result.items).toEqual(items.slice(0, 2));
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).not.toBeNull();

    const decoded = decodeCursor(result.nextCursor!);
    expect(decoded).toEqual({
      id: "2",
      createdAt: "2026-01-02T00:00:00.000Z",
    });
  });

  it("builds standard pagination envelope when on last page", () => {
    const items = [
      { id: "1", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "2", createdAt: "2026-01-02T00:00:00.000Z" },
    ];
    // Asking for limit 2 with 2 items received indicates hasMore: false
    const result = paginateEnvelope(items, 2);
    expect(result.items).toHaveLength(2);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });
});
