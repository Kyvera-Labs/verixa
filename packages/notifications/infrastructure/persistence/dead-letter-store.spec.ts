import { describe, expect, it } from "vitest";

import type { NotificationMessage } from "../../application/ports/notification-sender.js";

import { InMemoryDeadLetterStore } from "./dead-letter-store.js";

const notification: NotificationMessage = {
  id: "notification-1",
  recipient: "user@example.com",
  channel: "email",
  subject: "Security alert",
  body: "Your security alert",
};

describe("InMemoryDeadLetterStore", () => {
  it("retains the complete failure history and returns entries by id", async () => {
    const store = new InMemoryDeadLetterStore();
    const entry = {
      notification,
      failures: [
        { attempt: 1, failedAt: new Date("2026-01-01T00:00:00Z"), reason: "timeout" },
        { attempt: 2, failedAt: new Date("2026-01-01T00:01:00Z"), reason: "gateway unavailable" },
      ],
      exhaustedAt: new Date("2026-01-01T00:02:00Z"),
    };

    await store.save(entry);

    await expect(store.find(notification.id)).resolves.toEqual(entry);
    await expect(store.list()).resolves.toEqual([entry]);
  });

  it("reports removal and leaves the store empty", async () => {
    const store = new InMemoryDeadLetterStore();
    await store.save({ notification, failures: [], exhaustedAt: new Date() });

    await expect(store.remove(notification.id)).resolves.toBe(true);
    await expect(store.remove(notification.id)).resolves.toBe(false);
    await expect(store.find(notification.id)).resolves.toBeUndefined();
  });
});
