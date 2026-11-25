import { Result } from "@verixa/shared-kernel";

import {
  type DeliveryReceipt,
  type NotificationError,
  type NotificationMessage,
  type NotificationSender,
  InvalidRecipientError,
  MalformedNotificationPayloadError,
  NotificationTimeoutError,
  NotificationTransportError,
} from "../../application/ports/notification-sender.js";

export interface NoopNotificationSenderOptions {
  readonly simulatedFailure?:
    "timeout" | "transport_error" | "malformed" | "invalid_recipient" | undefined;
}

/**
 * In-memory test double for notification delivery.
 *
 * Captures sent notifications in memory for assertions and returns deterministic
 * delivery receipts without requiring external SMTP, SMS gateway, or webhook endpoints.
 */
export class NoopNotificationSender implements NotificationSender {
  readonly sent: NotificationMessage[] = [];
  private readonly simulatedFailure?:
    "timeout" | "transport_error" | "malformed" | "invalid_recipient" | undefined;

  constructor(options: NoopNotificationSenderOptions = {}) {
    this.simulatedFailure = options.simulatedFailure;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async send(message: NotificationMessage): Promise<Result<DeliveryReceipt, NotificationError>> {
    if (this.simulatedFailure === "timeout") {
      return Result.err(new NotificationTimeoutError());
    }

    if (this.simulatedFailure === "transport_error") {
      return Result.err(new NotificationTransportError());
    }

    if (
      this.simulatedFailure === "malformed" ||
      !message.body ||
      !message.body.trim() ||
      !message.id ||
      (message.channel === "email" && (!message.subject || !message.subject.trim()))
    ) {
      return Result.err(new MalformedNotificationPayloadError());
    }

    if (
      this.simulatedFailure === "invalid_recipient" ||
      !message.recipient ||
      message.recipient === "invalid@recipient"
    ) {
      return Result.err(new InvalidRecipientError());
    }

    this.sent.push(message);

    return Result.ok({
      messageId: `noop-${message.id}-${Date.now()}`,
      channel: message.channel,
      deliveredAt: new Date(),
    });
  }
}
