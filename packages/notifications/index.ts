// Public surface of @verixa/notifications. Curating it (and deciding whether
// the registry stays internal) is Issue 279's deliverable.

export {
  NotificationTemplate,
  type NotificationChannel,
  type NotificationTemplateDefinition,
} from "./domain/entities/notification-template.js";
export { TemplateRegistry } from "./domain/services/template-registry.js";
export {
  InMemoryNotificationDispatcher,
  NotificationService,
  type NotificationDispatcher,
  type NotificationReceipt,
  type SendNotificationInput,
} from "./src/index.js";

export {
  NotificationError,
  InvalidRecipientError,
  NotificationTimeoutError,
  MalformedNotificationPayloadError,
  NotificationTransportError,
  type NotificationMessage,
  type DeliveryReceipt,
  type NotificationSender,
} from "./application/ports/notification-sender.js";

export {
  NoopNotificationSender,
  type NoopNotificationSenderOptions,
} from "./infrastructure/adapters/noop-notification-sender.js";

export {
  HttpNotificationSender,
  type HttpNotificationSenderConfig,
} from "./infrastructure/adapters/http-notification-sender.js";

export {
  type NotificationDeliveryFailure,
  type NotificationDeliveryQueue,
} from "./application/ports/delivery-queue.js";
export {
  type DeadLetterNotification,
  type DeadLetterStore,
} from "./application/ports/dead-letter-store.js";
export { InMemoryDeadLetterStore } from "./infrastructure/persistence/dead-letter-store.js";
export { ReplayDeadLetterNotification } from "./application/use-cases/replay-dead-letter-notification.js";
