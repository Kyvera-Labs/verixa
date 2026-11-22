import { describe, expect, it } from "vitest";

import {
  HttpNotificationSender,
  InMemoryNotificationDispatcher,
  NotificationService,
  NotificationTemplate,
  TemplateRegistry,
} from "../index.js";

describe("notifications public API", () => {
  it("exposes the supported domain, application, and adapter surface", () => {
    expect(NotificationTemplate).toBeDefined();
    expect(TemplateRegistry).toBeDefined();
    expect(NotificationService).toBeDefined();
    expect(InMemoryNotificationDispatcher).toBeDefined();
    expect(HttpNotificationSender).toBeDefined();
  });
});
