import { createId, Result } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import { Organization } from "./organization.js";
import type { UserId } from "./user.js";

const ownerId = createId<"UserId">() as UserId;

describe("Organization", () => {
  it("creates an organization with a normalized slug and active status", () => {
    const result = Organization.create({ name: "Acme Inc", slug: "  Acme-Inc  ", ownerId });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.slug).toBe("acme-inc");
      expect(result.value.status).toBe("active");
      expect(result.value.ownerId).toBe(ownerId);
    }
  });

  it("trims the name", () => {
    const result = Organization.create({ name: "  Acme Inc  ", slug: "acme-inc", ownerId });

    expect(Result.isOk(result) && result.value.name).toBe("Acme Inc");
  });

  it("rejects an empty name", () => {
    const result = Organization.create({ name: "   ", slug: "acme-inc", ownerId });

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.fieldErrors["name"]).toContain("required");
    }
  });

  it("rejects a slug that is too short", () => {
    const result = Organization.create({ name: "Acme Inc", slug: "ab", ownerId });

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.fieldErrors["slug"]).toContain("too_short");
    }
  });

  it("rejects a slug with uppercase or invalid characters", () => {
    const result = Organization.create({ name: "Acme Inc", slug: "Acme_Inc!", ownerId });

    expect(Result.isErr(result)).toBe(true);
  });

  it("rejects a slug with leading, trailing, or doubled hyphens", () => {
    expect(Result.isErr(Organization.create({ name: "Acme", slug: "-acme", ownerId }))).toBe(true);
    expect(Result.isErr(Organization.create({ name: "Acme", slug: "acme-", ownerId }))).toBe(true);
    expect(Result.isErr(Organization.create({ name: "Acme", slug: "ac--me", ownerId }))).toBe(true);
  });

  it("requires exactly one owner at creation", () => {
    const result = Organization.create({ name: "Acme Inc", slug: "acme-inc", ownerId });

    expect(Result.isOk(result) && result.value.ownerId).toBe(ownerId);
  });
});

/**
 * Added in Issue 417. Each test kills mutants the mutation-testing spike found
 * surviving in organization.ts: the limits were tested well inside and well
 * outside, never at the edge, and the slug pattern's `^` anchor was never
 * needed by any test.
 */
describe("Organization.create: limits and format, at the edges", () => {
  const create = (name: string, slug: string) => Organization.create({ name, slug, ownerId });

  it("accepts a name of exactly the maximum length and rejects one more", () => {
    // Kills :76 (`>` -> `>=`, and the condition -> false).
    expect(Result.isOk(create("n".repeat(128), "acme"))).toBe(true);
    const tooLong = create("n".repeat(129), "acme");
    expect(Result.isErr(tooLong) && tooLong.error).toMatchObject({
      fieldErrors: { name: ["too_long"] },
    });
  });

  it("accepts a slug of exactly the minimum length", () => {
    // Kills :80 (`<` -> `<=`).
    expect(Result.isOk(create("Acme", "abc"))).toBe(true);
  });

  it("accepts a slug of exactly the maximum length and rejects one more", () => {
    // Kills :82 (`>` -> `>=`, and the condition -> false).
    expect(Result.isOk(create("Acme", "a".repeat(63)))).toBe(true);
    const tooLong = create("Acme", "a".repeat(64));
    expect(Result.isErr(tooLong) && tooLong.error).toMatchObject({
      fieldErrors: { slug: ["too_long"] },
    });
  });

  it("rejects a slug segment with a character outside a-z0-9 anywhere in it", () => {
    // Kills :13 (the `^` anchor dropped, so "acme_corp" matched on its "corp"
    // suffix) and :85 (the `invalid_format` field error emptied).
    const result = create("Acme", "acme_corp");
    expect(Result.isErr(result) && result.error).toMatchObject({
      fieldErrors: { slug: ["invalid_format"] },
    });
  });
});
