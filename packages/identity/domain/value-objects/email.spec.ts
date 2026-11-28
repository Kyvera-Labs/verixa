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

/** Kills mutants the mutation-testing spike found surviving in email.ts. */
describe("Email: edges the pattern and the limit must hold", () => {
  it("rejects an address with a second @ after a valid prefix", () => {
    // Kills :10 (the `$` anchor dropped): without it, "user@example.com" is
    // matched as a prefix and the rest of the string is never checked.
    const result = Email.create("user@example.com@evil.test");
    expect(Result.isErr(result) && result.error).toMatchObject({
      fieldErrors: { email: ["invalid_format"] },
    });
  });

  it("accepts an address of exactly the maximum length", () => {
    // Kills :40 (`>` -> `>=`). 254 characters is the RFC 5321 limit itself.
    const address = `${"a".repeat(254 - "@example.com".length)}@example.com`;
    expect(address).toHaveLength(254);
    expect(Result.isOk(Email.create(address))).toBe(true);
  });

  it("does not consider two different addresses equal", () => {
    // Kills :58 (`===` -> `true`).
    const a = Email.create("a@example.com");
    const b = Email.create("b@example.com");
    if (!Result.isOk(a) || !Result.isOk(b)) throw new Error("fixture setup failed");
    expect(a.value.equals(b.value)).toBe(false);
  });
});
