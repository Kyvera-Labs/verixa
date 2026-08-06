import { describe, expect, it } from "vitest";

import { ValidationError } from "../domain/errors.js";
import { Result } from "../domain/result.js";

import { ValidationErrorAggregator } from "./validation.js";

describe("ValidationErrorAggregator", () => {
  it("produces an ok Result when zero errors were collected", () => {
    const errors = new ValidationErrorAggregator();
    const value = errors.collect(Result.ok("alice@example.com"));

    expect(errors.hasErrors()).toBe(false);
    expect(errors.toResult(value)).toEqual(Result.ok("alice@example.com"));
  });

  it("collects a single field's errors", () => {
    const errors = new ValidationErrorAggregator();
    errors.collect(Result.err(new ValidationError("Email is invalid.", { email: ["required"] })));

    expect(errors.hasErrors()).toBe(true);
    const result = errors.toResult(undefined);
    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.fieldErrors).toEqual({ email: ["required"] });
    }
  });

  it("merges errors from N independent fields into one map", () => {
    const errors = new ValidationErrorAggregator();
    errors.collect(Result.err(new ValidationError("bad email", { email: ["required"] })));
    errors.collect(Result.ok("ignored"));
    errors.collect(
      Result.err(
        new ValidationError("bad name", { displayName: ["required"], givenName: ["too_long"] }),
      ),
    );

    const result = errors.toResult(undefined);
    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.fieldErrors).toEqual({
        email: ["required"],
        displayName: ["required"],
        givenName: ["too_long"],
      });
    }
  });

  it("merges multiple messages for the same field across calls", () => {
    const errors = new ValidationErrorAggregator();
    errors.merge({ slug: ["too_short"] });
    errors.merge({ slug: ["invalid_format"] });

    const error = errors.toError();
    expect(error.fieldErrors["slug"]).toEqual(["too_short", "invalid_format"]);
  });

  it("uses a custom message when provided", () => {
    const errors = new ValidationErrorAggregator();
    errors.merge({ name: ["required"] });

    const error = errors.toError("Organization is invalid.");
    expect(error.message).toBe("Organization is invalid.");
  });
});
