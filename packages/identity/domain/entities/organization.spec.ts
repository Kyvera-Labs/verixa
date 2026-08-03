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
