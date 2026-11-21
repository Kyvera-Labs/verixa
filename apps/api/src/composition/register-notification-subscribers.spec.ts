import type { DomainEventPublisher } from "@verixa/shared-kernel";
import { describe, expect, it, vi } from "vitest";

import { registerNotificationSubscribers } from "./register-notification-subscribers.js";

describe("registerNotificationSubscribers", () => {
  it("registers every subscriber in the supplied order", () => {
    const publisher = {} as DomainEventPublisher;
    const first = { register: vi.fn() };
    const second = { register: vi.fn() };

    registerNotificationSubscribers(publisher, [first, second]);

    expect(first.register).toHaveBeenCalledWith(publisher);
    expect(second.register).toHaveBeenCalledWith(publisher);
    const firstCallOrder = first.register.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
    const secondCallOrder = second.register.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
    expect(firstCallOrder).toBeLessThan(secondCallOrder);
  });
});
