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

/** Kills mutants the mutation-testing spike found surviving in person-name.ts. */
describe("PersonName: limits at the edges, and which part they name", () => {
  it("accepts a given and a family name of exactly the maximum length", () => {
    // Kills :35 and :39 (`>` -> `>=`).
    expect(Result.isOk(PersonName.create("g".repeat(128), "f".repeat(128)))).toBe(true);
  });

  it("names the given name when it is too long", () => {
    // Kills :36 (the `too_long` array emptied).
    const result = PersonName.create("g".repeat(129));
    expect(Result.isErr(result) && result.error).toMatchObject({
      fieldErrors: { givenName: ["too_long"] },
    });
  });

  it("names the family name when it is too long", () => {
    // Kills :40 (the `too_long` array emptied).
    const result = PersonName.create("Grace", "f".repeat(129));
    expect(Result.isErr(result) && result.error).toMatchObject({
      fieldErrors: { familyName: ["too_long"] },
    });
  });

  it("does not consider names equal when either part differs", () => {
    // Kills :58, each side of the `&&` replaced with `true` in turn: a
    // different given name alone, and a different family name alone, must
    // each make the names unequal.
    const grace = PersonName.create("Grace", "Hopper");
    const ada = PersonName.create("Ada", "Hopper");
    const graceKelly = PersonName.create("Grace", "Kelly");
    if (!Result.isOk(grace) || !Result.isOk(ada) || !Result.isOk(graceKelly)) {
      throw new Error("fixture setup failed");
    }
    expect(grace.value.equals(ada.value)).toBe(false);
    expect(grace.value.equals(graceKelly.value)).toBe(false);
  });
});
