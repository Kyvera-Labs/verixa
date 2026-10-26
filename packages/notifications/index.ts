// Public surface of @verixa/notifications. Curating it (and deciding whether
// the registry stays internal) is Issue 279's deliverable.

export {
  NotificationTemplate,
  type NotificationChannel,
  type NotificationTemplateDefinition,
} from "./domain/entities/notification-template.js";
export { TemplateRegistry } from "./domain/services/template-registry.js";
