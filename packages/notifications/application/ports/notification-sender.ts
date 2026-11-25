import { DomainError, type Result } from "@verixa/shared-kernel";

export interface NotificationMessage {
  readonly id: string;
  /** Destination address, phone number, or webhook URL. */
  readonly recipient: string;
  readonly channel: "email" | "sms" | "webhook";
  readonly subject?: string | undefined;
  readonly body: string;
}

export interface DeliveryReceipt {
  /** Upstream transport/gateway message identifier. */
  readonly messageId: string;
  readonly channel: "email" | "sms" | "webhook";
  readonly deliveredAt: Date;
}

/**
 * Base domain error for notification transmission failures.
 */
export abstract class NotificationError extends DomainError {}

/**
 * The recipient address or endpoint is invalid, malformed, or rejected by upstream gateway.
 */
export class InvalidRecipientError extends NotificationError {
  readonly code = "INVALID_RECIPIENT";
  readonly httpStatusHint = 400;

  constructor(message = "Recipient address is invalid or unroutable") {
    super(message);
  }
}

/**
 * Notification dispatch exceeded configured delivery timeout.
 */
export class NotificationTimeoutError extends NotificationError {
  readonly code = "NOTIFICATION_TIMEOUT";
  readonly httpStatusHint = 504;

  constructor(message = "Notification delivery gateway timed out") {
    super(message);
  }
}

/**
 * Notification payload was rejected or failed validation (e.g. empty body).
 */
export class MalformedNotificationPayloadError extends NotificationError {
  readonly code = "NOTIFICATION_MALFORMED_PAYLOAD";
  readonly httpStatusHint = 400;

  constructor(message = "Notification payload is malformed or missing required content") {
    super(message);
  }
}

/**
 * External delivery transport or upstream provider returned an error (5xx / network disconnect).
 */
export class NotificationTransportError extends NotificationError {
  readonly code = "NOTIFICATION_TRANSPORT_FAILED";
  readonly httpStatusHint = 503;

  constructor(message = "Failed to transmit notification through delivery gateway") {
    super(message);
  }
}

/**
 * Port for outbound message dispatch across notification channels (email, SMS, webhooks).
 *
 * Method contracts:
 * - `send` takes a `NotificationMessage` and attempts delivery.
 * - On success, returns `Result.ok(DeliveryReceipt)`.
 * - Empty body or missing id returns `MalformedNotificationPayloadError`.
 * - Empty or unroutable recipient returns `InvalidRecipientError`.
 * - Delivery gateway timeouts return `NotificationTimeoutError`.
 * - Network failures or 5xx gateway responses return `NotificationTransportError`.
 */
export interface NotificationSender {
  /**
   * Dispatches a notification through the underlying channel gateway.
   *
   * @param message Structured notification content and recipient details
   * @returns Result containing DeliveryReceipt or a specific NotificationError
   */
  send(message: NotificationMessage): Promise<Result<DeliveryReceipt, NotificationError>>;
}
