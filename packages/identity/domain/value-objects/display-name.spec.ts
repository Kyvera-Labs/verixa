import { Result } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import { DisplayName } from "./display-name.js";

describe("DisplayName", () => {
  it("accepts a normal name", () => {
    const result = DisplayName.create("Alice");

    expect(Result.isOk(result) && result.value.value).toBe("Alice");
  });

  it("trims surrounding whitespace", () => {
    const result = DisplayName.create("  Alice  ");

    expect(Result.isOk(result) && result.value.value).toBe("Alice");
  });

  it("rejects an empty string", () => {
    const result = DisplayName.create("   ");

    expect(Result.isErr(result)).toBe(true);
  });

  it("rejects a name longer than 64 characters", () => {
    const result = DisplayName.create("a".repeat(65));

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.fieldErrors["displayName"]).toContain("too_long");
    }
  });

  it("accepts unicode characters", () => {
    const result = DisplayName.create("Renée Müller 田中");

    expect(Result.isOk(result)).toBe(true);
  });

  it("equals compares by value", () => {
    const a = DisplayName.create("Alice");
    const b = DisplayName.create("Alice");

    expect(Result.isOk(a) && Result.isOk(b) && a.value.equals(b.value)).toBe(true);
  });
});
