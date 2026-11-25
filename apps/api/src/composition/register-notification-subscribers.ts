import type { NotificationSubscriber } from "@verixa/notifications";
import type { DomainEventPublisher } from "@verixa/shared-kernel";

/**
 * Registers notification subscribers before the API can publish a trigger
 * event. The list is supplied by composition so this registry does not know
 * which credential or future-context adapter a deployment selected.
 */
export function registerNotificationSubscribers(
  publisher: DomainEventPublisher,
  subscribers: readonly NotificationSubscriber[],
): void {
  for (const subscriber of subscribers) {
    subscriber.register(publisher);
  }
}
