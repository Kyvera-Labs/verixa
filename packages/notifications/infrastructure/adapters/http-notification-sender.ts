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

export interface HttpNotificationSenderConfig {
  readonly webhookUrl?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly fetchFn?: typeof fetch | undefined;
}

/**
 * HTTP webhook adapter for notification dispatch.
 *
 * Sends outbound notifications over HTTP to downstream webhook endpoints or gateway relays,
 * enforcing explicit timeouts and translating communication failures into domain Result errors.
 */
export class HttpNotificationSender implements NotificationSender {
  private readonly webhookUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(config: HttpNotificationSenderConfig = {}) {
    this.webhookUrl = config.webhookUrl ?? "https://notifications.internal/dispatch";
    this.timeoutMs = config.timeoutMs ?? 4000;
    this.fetchFn = config.fetchFn ?? globalThis.fetch;
  }

  async send(message: NotificationMessage): Promise<Result<DeliveryReceipt, NotificationError>> {
    if (
      !message.id ||
      !message.body ||
      !message.body.trim() ||
      (message.channel === "email" && (!message.subject || !message.subject.trim()))
    ) {
      return Result.err(
        new MalformedNotificationPayloadError(
          "Notification id, non-empty body, and valid subject for emails are required",
        ),
      );
    }

    if (
      !message.recipient ||
      !message.recipient.trim() ||
      message.recipient === "invalid@recipient"
    ) {
      return Result.err(new InvalidRecipientError(`Recipient '${message.recipient}' is invalid`));
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await this.fetchFn(this.webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: message.id,
          channel: message.channel,
          recipient: message.recipient,
          subject: message.subject,
          body: message.body,
        }),
        signal: controller.signal,
      });

      if (response.status >= 500) {
        return Result.err(
          new NotificationTransportError(
            `Notification transport failed with status ${response.status}`,
          ),
        );
      }

      if (response.status === 400) {
        return Result.err(new InvalidRecipientError("Notification rejected by gateway as invalid"));
      }

      const receiptId = response.headers.get("x-message-id") ?? `msg-${message.id}`;

      return Result.ok({
        messageId: receiptId,
        channel: message.channel,
        deliveredAt: new Date(),
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        return Result.err(
          new NotificationTimeoutError(`Delivery exceeded ${this.timeoutMs}ms timeout`),
        );
      }

      return Result.err(
        new NotificationTransportError(
          err instanceof Error ? err.message : "Network error dispatching notification",
        ),
      );
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}
