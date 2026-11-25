import { NotFoundError, Result } from "@verixa/shared-kernel";

import type { DeadLetterNotification, DeadLetterStore } from "../ports/dead-letter-store.js";
import type { NotificationDeliveryQueue } from "../ports/delivery-queue.js";

export type ReplayDeadLetterResult = Result<DeadLetterNotification, NotFoundError>;

/**
 * Re-enqueues an exhausted notification through the normal delivery queue.
 * Removal happens only after enqueue succeeds, so a queue outage leaves the
 * record inspectable and replayable.
 */
export class ReplayDeadLetterNotification {
  constructor(
    private readonly deadLetters: DeadLetterStore,
    private readonly queue: NotificationDeliveryQueue,
  ) {}

  async execute(notificationId: string): Promise<ReplayDeadLetterResult> {
    const entry = await this.deadLetters.find(notificationId);
    if (entry === undefined) {
      return Result.err(new NotFoundError(`No dead-letter notification exists for "${notificationId}".`));
    }

    await this.queue.enqueue(entry.notification);
    await this.deadLetters.remove(notificationId);
    return Result.ok(entry);
  }
}
