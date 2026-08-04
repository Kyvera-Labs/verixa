import { describe, expect, it } from "vitest";

import { BaseDomainEvent } from "./domain-event.js";

class TestEvent extends BaseDomainEvent {
  readonly eventName = "test.event";

  constructor(
    aggregateId: string,
    readonly payload: string,
  ) {
    super(aggregateId);
  }
}

describe("BaseDomainEvent", () => {
  it("carries the aggregate id it was constructed with", () => {
    const event = new TestEvent("aggregate-1", "payload");

    expect(event.aggregateId).toBe("aggregate-1");
  });

  it("stamps occurredAt at construction time", () => {
    const before = Date.now();
    const event = new TestEvent("aggregate-1", "payload");
    const after = Date.now();

    expect(event.occurredAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(event.occurredAt.getTime()).toBeLessThanOrEqual(after);
  });

  it("exposes the subclass-defined eventName", () => {
    const event = new TestEvent("aggregate-1", "payload");

    expect(event.eventName).toBe("test.event");
  });

  it("carries event-specific data declared by the subclass", () => {
    const event = new TestEvent("aggregate-1", "payload");

    expect(event.payload).toBe("payload");
  });
});
