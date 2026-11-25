import { Result } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import { InMemoryNotificationDispatcher, NotificationService } from "../src/types.js";

describe("NotificationService", () => {
  it("dispatches notification successfully with valid inputs", async () => {
    const dispatcher = new InMemoryNotificationDispatcher();
    const service = new NotificationService(dispatcher);

    const result = await service.send({
      to: "test@example.com",
      subject: "Welcome to Verixa",
      body: "Your verification code is 123456",
      channel: "email",
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.to).toBe("test@example.com");
      expect(result.value.subject).toBe("Welcome to Verixa");
      expect(result.value.channel).toBe("email");
      expect(result.value.id).toBeDefined();
    }

    expect(dispatcher.dispatched).toHaveLength(1);
    expect(dispatcher.dispatched[0]?.to).toBe("test@example.com");
  });

  it("defaults channel to email when omitted", async () => {
    const dispatcher = new InMemoryNotificationDispatcher();
    const service = new NotificationService(dispatcher);

    const result = await service.send({
      to: "user@example.com",
      subject: "Subject",
      body: "Body",
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.channel).toBe("email");
    }
  });

  it("returns ValidationError if recipient 'to' is empty", async () => {
    const dispatcher = new InMemoryNotificationDispatcher();
    const service = new NotificationService(dispatcher);

    const result = await service.send({
      to: "  ",
      subject: "Subject",
      body: "Body",
    });

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.message).toContain("Recipient 'to' must not be empty");
    }
    expect(dispatcher.dispatched).toHaveLength(0);
  });

  it("returns ValidationError if subject is empty", async () => {
    const dispatcher = new InMemoryNotificationDispatcher();
    const service = new NotificationService(dispatcher);

    const result = await service.send({
      to: "user@example.com",
      subject: "",
      body: "Body",
    });

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.message).toContain("Notification 'subject' must not be empty");
    }
    expect(dispatcher.dispatched).toHaveLength(0);
  });

  it("returns ValidationError if body is empty", async () => {
    const dispatcher = new InMemoryNotificationDispatcher();
    const service = new NotificationService(dispatcher);

    const result = await service.send({
      to: "user@example.com",
      subject: "Subject",
      body: "",
    });

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.message).toContain("Notification 'body' must not be empty");
    }
    expect(dispatcher.dispatched).toHaveLength(0);
  });

  it("clears dispatched notifications in InMemoryNotificationDispatcher", async () => {
    const dispatcher = new InMemoryNotificationDispatcher();
    const service = new NotificationService(dispatcher);

    await service.send({
      to: "user@example.com",
      subject: "Test",
      body: "Test body",
    });

    expect(dispatcher.dispatched).toHaveLength(1);
    dispatcher.clear();
    expect(dispatcher.dispatched).toHaveLength(0);
  });
});
