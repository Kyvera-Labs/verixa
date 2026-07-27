import { describe, expect, it } from "vitest";

import { Result } from "./result.js";

describe("Result", () => {
  it("ok() produces an Ok result carrying the value", () => {
    const result = Result.ok(42);

    expect(Result.isOk(result)).toBe(true);
    expect(Result.isErr(result)).toBe(false);
  });

  it("err() produces an Err result carrying the error", () => {
    const result = Result.err("failed");

    expect(Result.isErr(result)).toBe(true);
    expect(Result.isOk(result)).toBe(false);
  });

  describe("map", () => {
    it("transforms the value inside an Ok", () => {
      const result = Result.map(Result.ok(2), (value: number) => value * 10);

      expect(Result.match(result, { ok: (value) => value, err: () => -1 })).toBe(20);
    });

    it("leaves an Err untouched", () => {
      const original = Result.err<string>("boom");
      const result = Result.map(original, (value: number) => value * 10);

      expect(result).toBe(original);
    });
  });

  describe("flatMap", () => {
    const parsePositive = (value: number): Result<number, string> =>
      value > 0 ? Result.ok(value) : Result.err("must be positive");

    it("chains two successful steps without nesting", () => {
      const result = Result.flatMap(Result.ok(5), parsePositive);

      expect(Result.match(result, { ok: (value) => value, err: () => -1 })).toBe(5);
    });

    it("short-circuits on the first Err and never calls the next step", () => {
      let called = false;
      const original = Result.err<string>("already failed");

      const result = Result.flatMap(original, (value: number) => {
        called = true;
        return parsePositive(value);
      });

      expect(called).toBe(false);
      expect(result).toBe(original);
    });

    it("propagates a failure raised by the chained step", () => {
      const result = Result.flatMap(Result.ok(-5), parsePositive);

      expect(Result.match(result, { ok: () => "unexpected", err: (error) => error })).toBe(
        "must be positive",
      );
    });
  });

  describe("match", () => {
    it("calls the ok handler for an Ok result", () => {
      const output = Result.match(Result.ok(1), { ok: () => "ok-branch", err: () => "err-branch" });

      expect(output).toBe("ok-branch");
    });

    it("calls the err handler for an Err result", () => {
      const output = Result.match(Result.err("nope"), {
        ok: () => "ok-branch",
        err: () => "err-branch",
      });

      expect(output).toBe("err-branch");
    });
  });
});
