import { describe, expect, it } from "vitest";

import { Result } from "@verixa/shared-kernel";

import { InMemoryDeadLetterStore } from "../../infrastructure/persistence/dead-letter-store.js";
import type { NotificationMessage } from "../ports/notification-sender.js";
import { ReplayDeadLetterNotification } from "./replay-dead-letter-notification.js";

const notification: NotificationMessage = {
  id: "notification-2",
  recipient: "+15551234567",
  channel: "sms",
  body: "Try again",
};

describe("ReplayDeadLetterNotification", () => {
  it("re-enqueues the original notification and removes it after success", async () => {
    const store = new InMemoryDeadLetterStore();
    const queued: NotificationMessage[] = [];
    await store.save({ notification, failures: [], exhaustedAt: new Date() });
    const replay = new ReplayDeadLetterNotification(store, {
      enqueue: async (message) => { queued.push(message); },
    });

    const result = await replay.execute(notification.id);

    expect(Result.isOk(result)).toBe(true);
    expect(queued).toEqual([notification]);
    await expect(store.find(notification.id)).resolves.toBeUndefined();
  });

  it("keeps the dead-letter record when enqueue fails", async () => {
    const store = new InMemoryDeadLetterStore();
    const entry = { notification, failures: [], exhaustedAt: new Date() };
    await store.save(entry);
    const replay = new ReplayDeadLetterNotification(store, {
      enqueue: async () => {
        throw new Error("queue unavailable");
      },
    });

    await expect(replay.execute(notification.id)).rejects.toThrow("queue unavailable");
    await expect(store.find(notification.id)).resolves.toEqual(entry);
  });

  it("returns a typed not-found result", async () => {
    const replay = new ReplayDeadLetterNotification(new InMemoryDeadLetterStore(), {
      enqueue: async () => undefined,
    });

    const result = await replay.execute("missing");

    expect(Result.isErr(result)).toBe(true);
  });
});
