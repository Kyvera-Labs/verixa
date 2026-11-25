import type { NotificationMessage } from "./notification-sender.js";

/** A notification that has failed one delivery attempt. */
export interface NotificationDeliveryFailure {
  readonly attempt: number;
  readonly failedAt: Date;
  readonly reason: string;
}

/** The queue boundary shared by delivery and dead-letter replay. */
export interface NotificationDeliveryQueue {
  enqueue(message: NotificationMessage): Promise<void>;
}
