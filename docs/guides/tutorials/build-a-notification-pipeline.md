# Build a notification pipeline

This guide follows a notification from an application event to a delivery
receipt. The example uses the `packages/notifications` package, which keeps
validation and delivery separate so callers can test business behavior
without a real email provider.

## 1. Create a message at the boundary

An application turns its domain event into a `SendNotificationInput` with a
recipient, subject, body, and optional channel. `NotificationService` rejects
empty recipients, subjects, and bodies before a dispatcher is called. That
keeps malformed input out of every downstream adapter.

```ts
const result = await service.send({
  to: user.email,
  subject: "Your verification code",
  body: renderVerificationMessage(code),
  channel: "email",
});
```

The service returns a `Result`, not a thrown transport error. The successful
value is a receipt containing a stable notification id, destination, channel,
and send time.

## 2. Render safely with templates

Use `NotificationTemplate.create` to validate a template definition, then put
the complete set into `TemplateRegistry.create` at startup. The registry is
immutable after construction: duplicate keys and invalid definitions fail the
whole startup check, and an unknown key returns a typed `NotFoundError`
before rendering or dispatching. Keep user-controlled values as template
variables and escape them in the renderer; never concatenate untrusted HTML
into a template definition.

## 3. Dispatch through a port

`NotificationDispatcher` is the application port. Tests can use
`InMemoryNotificationDispatcher` and inspect its `dispatched` receipts. A
production composition root can select an HTTP adapter or a provider-specific
adapter without changing the service or the domain types.

The HTTP adapter posts a small JSON envelope containing the message id,
channel, recipient, subject, and body. It applies an explicit timeout and
maps provider responses to domain errors:

- 400 becomes an invalid-recipient error.
- 5xx responses become a retryable transport error.
- Abort signals become a timeout error.
- Other network failures become transport errors.

## 4. Retry without duplicating delivery

Retry only transient transport and timeout errors. Keep the notification id
constant across attempts and record the attempt count in the caller's job
store. A provider that supports idempotency should receive that id so a
successful request followed by a lost response cannot send a duplicate.

Use bounded exponential backoff with jitter, for example 1s, 2s, and 4s.
After the final attempt, move the message to a dead-letter queue containing
the error category and last provider response. Do not retry validation or
invalid-recipient errors.

## 5. Respect preferences before dispatch

Resolve the recipient's channel and preference policy before invoking the
dispatcher. A disabled channel should produce a recorded skip, not a failed
delivery. Keep opt-out decisions in the application layer so the dispatcher
remains a transport adapter and cannot accidentally bypass the preference
center.

## 6. Test the whole path locally

Start with the in-memory dispatcher and cover:

1. an event producing a valid message and receipt;
2. invalid input being rejected without dispatch;
3. an unknown template key failing before render;
4. a timeout retrying with the same id;
5. a permanent recipient error going directly to a dead-letter outcome; and
6. a disabled preference producing a recorded skip.

This design closes the email-delivery gap deferred from the earlier credential
phases while keeping domain logic deterministic and provider failures
observable.
