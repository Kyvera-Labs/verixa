import { Result, ValidationError } from "@verixa/shared-kernel";

import { type NotificationChannel } from "../domain/entities/notification-template.js";

export { type NotificationChannel };

export interface SendNotificationInput {
  to: string;
  subject: string;
  body: string;
  channel?: NotificationChannel;
}

export interface NotificationReceipt {
  id: string;
  to: string;
  subject: string;
  channel: NotificationChannel;
  sentAt: Date;
}

export interface NotificationDispatcher {
  dispatch(notification: NotificationReceipt): Promise<void>;
}

export class InMemoryNotificationDispatcher implements NotificationDispatcher {
  public dispatched: NotificationReceipt[] = [];

  public dispatch(notification: NotificationReceipt): Promise<void> {
    this.dispatched.push(notification);
    return Promise.resolve();
  }

  public clear(): void {
    this.dispatched = [];
  }
}

export class NotificationService {
  constructor(private readonly dispatcher: NotificationDispatcher) {}

  public async send(
    input: SendNotificationInput,
  ): Promise<Result<NotificationReceipt, ValidationError>> {
    if (!input.to || !input.to.trim()) {
      return Result.err(new ValidationError("Recipient 'to' must not be empty."));
    }
    if (!input.subject || !input.subject.trim()) {
      return Result.err(new ValidationError("Notification 'subject' must not be empty."));
    }
    if (!input.body || !input.body.trim()) {
      return Result.err(new ValidationError("Notification 'body' must not be empty."));
    }

    const channel: NotificationChannel = input.channel ?? "email";
    const receipt: NotificationReceipt = {
      id: `notif_${Math.random().toString(36).slice(2, 11)}_${Date.now()}`,
      to: input.to.trim(),
      subject: input.subject.trim(),
      channel,
      sentAt: new Date(),
    };

    await this.dispatcher.dispatch(receipt);
    return Result.ok(receipt);
  }
}
