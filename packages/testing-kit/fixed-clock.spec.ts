import { describe, expect, it } from "vitest";

import { FixedClock } from "./fixed-clock.js";

describe("FixedClock", () => {
  it("returns the initial instant and advances by milliseconds", () => {
    const clock = new FixedClock("2026-01-01T00:00:00.000Z");

    clock.advance(1_500);

    expect(clock.now().toISOString()).toBe("2026-01-01T00:00:01.500Z");
  });

  it("sets the current instant and does not expose mutable internal dates", () => {
    const clock = new FixedClock(0);
    const returnedDate = clock.now();
    returnedDate.setFullYear(2000);

    clock.set("2026-01-02T00:00:00.000Z");

    expect(clock.now().toISOString()).toBe("2026-01-02T00:00:00.000Z");
  });

  it("rejects invalid instants and non-finite advances", () => {
    const clock = new FixedClock(0);

    expect(() => clock.set("invalid")).toThrow(RangeError);
    expect(() => clock.advance(Number.NaN)).toThrow(RangeError);
  });
});
