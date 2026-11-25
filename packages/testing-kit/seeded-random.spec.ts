import { describe, expect, it } from "vitest";

import { SeededRandom } from "./seeded-random.js";

describe("SeededRandom", () => {
  it("repeats the same sequence for the same seed", () => {
    const first = new SeededRandom(42);
    const second = new SeededRandom(42);

    expect(Array.from({ length: 5 }, () => first.next())).toEqual(
      Array.from({ length: 5 }, () => second.next()),
    );
  });

  it("returns values in the half-open unit interval", () => {
    const random = new SeededRandom(123);
    const values = Array.from({ length: 100 }, () => random.next());

    expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
  });

  it("rejects non-integer seeds", () => {
    expect(() => new SeededRandom(1.5)).toThrow(TypeError);
  });
});
