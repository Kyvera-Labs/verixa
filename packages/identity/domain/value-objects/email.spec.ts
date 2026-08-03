import { Result } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import { Email } from "./email.js";

describe("Email", () => {
  it("accepts a well-formed address", () => {
    const result = Email.create("alice@example.com");

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.value).toBe("alice@example.com");
    }
  });

  it("normalizes case and surrounding whitespace", () => {
    const result = Email.create("  Alice@Example.COM  ");

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.value).toBe("alice@example.com");
    }
  });

  it("treats differently-cased equal addresses as equal", () => {
    const a = Email.create("Alice@Example.com");
    const b = Email.create("alice@example.com");

    expect(Result.isOk(a) && Result.isOk(b) && a.value.equals(b.value)).toBe(true);
  });

  it("rejects an empty string", () => {
    const result = Email.create("");

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.fieldErrors["email"]).toContain("required");
    }
  });

  it("rejects a string with no @", () => {
    const result = Email.create("not-an-email");

    expect(Result.isErr(result)).toBe(true);
  });

  it("rejects a string with no domain dot", () => {
    const result = Email.create("alice@localhost");

    expect(Result.isErr(result)).toBe(true);
  });

  it("rejects a string containing whitespace", () => {
    const result = Email.create("ali ce@example.com");

    expect(Result.isErr(result)).toBe(true);
  });

  it("rejects an address longer than 254 characters", () => {
    const longLocal = "a".repeat(250);
    const result = Email.create(`${longLocal}@example.com`);

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.fieldErrors["email"]).toContain("too_long");
    }
  });

  it("toString returns the normalized value", () => {
    const result = Email.create("Bob@Example.com");

    expect(Result.isOk(result) && result.value.toString()).toBe("bob@example.com");
  });
});
