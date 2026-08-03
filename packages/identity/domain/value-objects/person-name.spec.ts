import { Result } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import { PersonName } from "./person-name.js";

describe("PersonName", () => {
  it("accepts a given and family name", () => {
    const result = PersonName.create("Alice", "Smith");

    expect(Result.isOk(result) && result.value.toFullName()).toBe("Alice Smith");
  });

  it("accepts a given name with no family name (mononym)", () => {
    const result = PersonName.create("Madonna");

    expect(Result.isOk(result) && result.value.toFullName()).toBe("Madonna");
    expect(Result.isOk(result) && result.value.familyName).toBeUndefined();
  });

  it("treats an empty family name as absent", () => {
    const result = PersonName.create("Madonna", "   ");

    expect(Result.isOk(result) && result.value.familyName).toBeUndefined();
  });

  it("accepts unicode given/family names", () => {
    const result = PersonName.create("田中", "太郎");

    expect(Result.isOk(result) && result.value.toFullName()).toBe("田中 太郎");
  });

  it("rejects an empty given name", () => {
    const result = PersonName.create("   ");

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.fieldErrors["givenName"]).toContain("required");
    }
  });

  it("rejects a given name longer than 128 characters", () => {
    const result = PersonName.create("a".repeat(129));

    expect(Result.isErr(result)).toBe(true);
  });

  it("rejects a family name longer than 128 characters", () => {
    const result = PersonName.create("Alice", "b".repeat(129));

    expect(Result.isErr(result)).toBe(true);
  });

  it("equals compares given and family name", () => {
    const a = PersonName.create("Alice", "Smith");
    const b = PersonName.create("Alice", "Smith");
    const c = PersonName.create("Alice", "Jones");

    expect(Result.isOk(a) && Result.isOk(b) && a.value.equals(b.value)).toBe(true);
    expect(Result.isOk(a) && Result.isOk(c) && a.value.equals(c.value)).toBe(false);
  });
});
