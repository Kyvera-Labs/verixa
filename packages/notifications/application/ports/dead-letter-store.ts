import type { NotificationDeliveryFailure } from "./delivery-queue.js";
import type { NotificationMessage } from "./notification-sender.js";

export interface DeadLetterNotification {
  readonly notification: NotificationMessage;
  readonly failures: readonly NotificationDeliveryFailure[];
  readonly exhaustedAt: Date;
}

/** Persistence boundary for notifications that have exhausted delivery. */
export interface DeadLetterStore {
  save(entry: DeadLetterNotification): Promise<void>;
  find(notificationId: string): Promise<DeadLetterNotification | undefined>;
  list(): Promise<readonly DeadLetterNotification[]>;
  remove(notificationId: string): Promise<boolean>;
}
