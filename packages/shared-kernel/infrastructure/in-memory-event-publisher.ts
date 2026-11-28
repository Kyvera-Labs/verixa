import type {
  DomainEvent,
  DomainEventHandler,
  DomainEventPublisher,
} from "../domain/domain-event.js";

/**
 * In-process, synchronous domain event publisher. Handlers run in subscription order within the
 * publishing request, so audit and other side effects finish before the response is sent. A slow
 * handler blocks the request; the fix for that is an out-of-process event bus, not making this one
 * asynchronous.
 */
export class InMemoryEventPublisher implements DomainEventPublisher {
  private readonly handlers = new Map<string, DomainEventHandler[]>();

  subscribe<E extends DomainEvent>(eventName: string, handler: DomainEventHandler<E>): void {
    const existing = this.handlers.get(eventName) ?? [];
    existing.push(handler as DomainEventHandler);
    this.handlers.set(eventName, existing);
  }

  async publish(event: DomainEvent): Promise<void> {
    const handlers = this.handlers.get(event.eventName) ?? [];

    for (const handler of handlers) {
      await handler(event);
    }
  }
}
