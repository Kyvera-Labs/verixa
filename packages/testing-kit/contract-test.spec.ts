import { describe, expect, it } from "vitest";

import { defineContractTests } from "./contract-test.js";

interface Counter {
  increment(): number;
  value(): number;
}

function counter(): Counter {
  let value = 0;
  return {
    increment: () => ++value,
    value: () => value,
  };
}

describe("defineContractTests", () => {
  it("rejects missing or duplicate implementation names", () => {
    expect(() => defineContractTests([], () => undefined)).toThrow("at least one");
    expect(() =>
      defineContractTests(
        [
          { name: "same", factory: counter },
          { name: "same", factory: counter },
        ],
        () => undefined,
      ),
    ).toThrow("Duplicate contract implementation name");
  });
});

defineContractTests(
  [
    { name: "in-memory fake", factory: counter },
    { name: "async in-memory fake", factory: () => Promise.resolve(counter()) },
  ],
  (port) => {
    it("starts at zero and increments", () => {
      expect(port().value()).toBe(0);
      expect(port().increment()).toBe(1);
      expect(port().value()).toBe(1);
    });
  },
);

const broken: Counter = { increment: () => 0, value: () => 0 };
defineContractTests([{ name: "intentionally broken fake", factory: () => broken }], (port) => {
  it.fails("reports a behavioral mismatch", () => {
    expect(port().increment()).toBe(1);
  });
});
