import { describe, expect, it } from "vitest";

import { BaseDomainEvent } from "../domain/domain-event.js";

import { InMemoryEventPublisher } from "./in-memory-event-publisher.js";

class OrderCreatedEvent extends BaseDomainEvent {
  readonly eventName = "order.created";
  constructor(
    aggregateId: string,
    readonly total: number,
  ) {
    super(aggregateId);
  }
}

describe("InMemoryEventPublisher", () => {
  it("delivers published events to subscribers in order", async () => {
    const publisher = new InMemoryEventPublisher();
    const calls: number[] = [];

    publisher.subscribe("order.created", async (event) => {
      calls.push((event as OrderCreatedEvent).total);
      await Promise.resolve();
    });

    publisher.subscribe("order.created", async (event) => {
      calls.push((event as OrderCreatedEvent).total * 2);
      await Promise.resolve();
    });

    await publisher.publish(new OrderCreatedEvent("order-1", 50));

    expect(calls).toEqual([50, 100]);
  });

  it("safely handles publishing an event with no subscribers", async () => {
    const publisher = new InMemoryEventPublisher();
    await expect(publisher.publish(new OrderCreatedEvent("order-2", 10))).resolves.toBeUndefined();
  });
});
