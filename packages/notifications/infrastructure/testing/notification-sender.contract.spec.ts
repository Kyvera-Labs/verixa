import { Result } from "@verixa/shared-kernel";
import { defineContractTests } from "@verixa/testing-kit/contract-test";
import { describe, expect, it } from "vitest";

import {
  type NotificationMessage,
  type NotificationSender,
  InvalidRecipientError,
  MalformedNotificationPayloadError,
  NotificationTimeoutError,
  NotificationTransportError,
} from "../../application/ports/notification-sender.js";
import { HttpNotificationSender } from "../adapters/http-notification-sender.js";
import { NoopNotificationSender } from "../adapters/noop-notification-sender.js";

function createMockNotificationFetch(mode: "ok" | "timeout" | "transport_error"): typeof fetch {
  return (_input, init) => {
    if (mode === "timeout") {
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            const err = new Error("This operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        }
      });
    }

    if (mode === "transport_error") {
      return Promise.resolve(new Response("Gateway error", { status: 502 }));
    }

    const bodyStr = typeof init?.body === "string" ? init.body : "{}";
    const payload = JSON.parse(bodyStr) as NotificationMessage;

    if (!payload.recipient || payload.recipient === "invalid@recipient") {
      return Promise.resolve(
        new Response(JSON.stringify({ error: "invalid recipient" }), { status: 400 }),
      );
    }

    return Promise.resolve(
      new Response(JSON.stringify({ status: "queued" }), {
        status: 200,
        headers: { "x-message-id": `upstream-${payload.id}` },
      }),
    );
  };
}

defineContractTests<NotificationSender>(
  [
    {
      name: "NoopNotificationSender",
      factory: () => new NoopNotificationSender(),
    },
    {
      name: "HttpNotificationSender (simulated network adapter)",
      factory: () =>
        new HttpNotificationSender({
          webhookUrl: "https://notify.example.internal/messages",
          timeoutMs: 100,
          fetchFn: createMockNotificationFetch("ok"),
        }),
    },
  ],
  (adapterFactory) => {
    const validMessage: NotificationMessage = {
      id: "msg-001",
      recipient: "user@example.com",
      channel: "email",
      subject: "Your verification code",
      body: "Your single-use code is 123456.",
    };

    it("sends a valid notification successfully and returns delivery receipt", async () => {
      const adapter = adapterFactory();
      const result = await adapter.send(validMessage);

      expect(Result.isOk(result)).toBe(true);
      if (Result.isOk(result)) {
        expect(result.value.channel).toBe("email");
        expect(result.value.messageId).toBeDefined();
        expect(result.value.deliveredAt).toBeInstanceOf(Date);
      }
    });

    it("rejects an invalid recipient format with InvalidRecipientError", async () => {
      const adapter = adapterFactory();
      const invalidMsg: NotificationMessage = {
        ...validMessage,
        recipient: "invalid@recipient",
      };

      const result = await adapter.send(invalidMsg);
      expect(Result.isErr(result)).toBe(true);
      if (Result.isErr(result)) {
        expect(result.error).toBeInstanceOf(InvalidRecipientError);
      }
    });

    it("rejects an empty message body with MalformedNotificationPayloadError", async () => {
      const adapter = adapterFactory();
      const emptyMsg: NotificationMessage = {
        ...validMessage,
        body: "   ",
      };

      const result = await adapter.send(emptyMsg);
      expect(Result.isErr(result)).toBe(true);
      if (Result.isErr(result)) {
        expect(result.error).toBeInstanceOf(MalformedNotificationPayloadError);
      }
    });

    it("rejects an email message with an empty subject", async () => {
      const adapter = adapterFactory();
      const noSubjectMsg: NotificationMessage = {
        ...validMessage,
        channel: "email",
        subject: "  ",
      };

      const result = await adapter.send(noSubjectMsg);
      expect(Result.isErr(result)).toBe(true);
      if (Result.isErr(result)) {
        expect(result.error).toBeInstanceOf(MalformedNotificationPayloadError);
      }
    });
  },
);

describe("NotificationSender Failure Modes Contract", () => {
  const sampleMessage: NotificationMessage = {
    id: "fail-msg-01",
    recipient: "user@example.com",
    channel: "email",
    subject: "Security Notification",
    body: "New login observed.",
  };

  it("handles upstream network timeout with NotificationTimeoutError", async () => {
    const timeoutAdapter = new HttpNotificationSender({
      webhookUrl: "https://notify.example.internal/messages",
      timeoutMs: 50,
      fetchFn: createMockNotificationFetch("timeout"),
    });

    const result = await timeoutAdapter.send(sampleMessage);
    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error).toBeInstanceOf(NotificationTimeoutError);
    }
  });

  it("handles gateway 502 error with NotificationTransportError", async () => {
    const errorAdapter = new HttpNotificationSender({
      webhookUrl: "https://notify.example.internal/messages",
      timeoutMs: 50,
      fetchFn: createMockNotificationFetch("transport_error"),
    });

    const result = await errorAdapter.send(sampleMessage);
    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error).toBeInstanceOf(NotificationTransportError);
    }
  });

  it("simulates Noop adapter timeout failure mode", async () => {
    const noopTimeout = new NoopNotificationSender({ simulatedFailure: "timeout" });
    const result = await noopTimeout.send(sampleMessage);
    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error).toBeInstanceOf(NotificationTimeoutError);
    }
  });

  it("simulates Noop adapter transport failure mode", async () => {
    const noopTransport = new NoopNotificationSender({ simulatedFailure: "transport_error" });
    const result = await noopTransport.send(sampleMessage);
    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error).toBeInstanceOf(NotificationTransportError);
    }
  });
});
