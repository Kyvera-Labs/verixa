import { describe, expect, it } from "vitest";

import type { DomainEvent } from "../domain/domain-event.js";

import { InMemoryEventPublisher } from "./in-memory-event-publisher.js";

/**
 * The mutation-testing spike found this publisher with no
 * direct tests (every mutant "no coverage"). The composition root wires it up,
 * and the audit subscriber depends on its two promises: every subscribed
 * handler runs, and they run in subscription order, each finishing before the
 * next starts.
 */

const event = (eventName: string): DomainEvent => ({
  eventName,
  aggregateId: "aggregate-1",
  occurredAt: new Date("2026-01-01T00:00:00.000Z"),
});

describe("InMemoryEventPublisher", () => {
  it("delivers a published event to its subscriber", async () => {
    // Kills the emptied subscribe/publish blocks, the dropped push/set calls,
    // and the `?? []` -> `&& []` mutants (which leave no handler to call).
    const publisher = new InMemoryEventPublisher();
    const received: DomainEvent[] = [];
    publisher.subscribe("user.registered", (e) => {
      received.push(e);
    });

    const published = event("user.registered");
    await publisher.publish(published);

    expect(received).toEqual([published]);
  });

  it("runs every handler for an event, in subscription order, awaiting each", async () => {
    // Kills the `?? []` -> `["Stryker was here"]` mutant in subscribe (it
    // would drop earlier handlers) and the emptied for-loop body.
    const publisher = new InMemoryEventPublisher();
    const calls: string[] = [];
    publisher.subscribe("user.registered", async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      calls.push("first");
    });
    publisher.subscribe("user.registered", () => {
      calls.push("second");
    });

    await publisher.publish(event("user.registered"));

    expect(calls).toEqual(["first", "second"]);
  });

  it("does not deliver an event to handlers subscribed to a different name", async () => {
    const publisher = new InMemoryEventPublisher();
    const calls: string[] = [];
    publisher.subscribe("user.suspended", () => {
      calls.push("suspended");
    });

    await publisher.publish(event("user.registered"));

    expect(calls).toEqual([]);
  });

  it("publishes an event nobody subscribed to without failing", async () => {
    // Kills the `?? []` -> `["Stryker was here"]` mutant in publish, which
    // would try to call a string as a handler.
    const publisher = new InMemoryEventPublisher();

    await expect(publisher.publish(event("nobody.listens"))).resolves.toBeUndefined();
  });
});
