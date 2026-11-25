# Notification subsystem threat model

This model applies STRIDE to the path from a domain event through template
rendering, preferences, retry/backoff, and an outbound provider. The security
boundary is the notification package: it accepts trusted application inputs,
but recipient addresses, template variables, and provider responses can all be
attacker-influenced.

| Threat | Example | Mitigation or accepted risk |
| --- | --- | --- |
| Spoofing | A caller sends as another user or forges a provider callback. | Authenticate the event-producing use case and bind preference lookups to the identity. Provider callbacks need signed, replay-protected envelopes (tracked with the webhook-signing work in #215). |
| Tampering | Template variables inject HTML, headers, or a different recipient. | Validate templates at startup, keep definitions immutable, escape variables at render time, and build transport fields from typed values. Never accept arbitrary headers from a template. (#209, #210) |
| Repudiation | An operator cannot explain why a message was sent or retried. | Persist the notification id, channel, attempts, outcome, and error category in the delivery job/audit record. Keep the same id across retries. |
| Information disclosure | A notification leaks another user's email or a secret in its body. | Resolve recipients from the authenticated identity, redact secrets before rendering, minimize message content, and avoid logging bodies or credentials. |
| Denial of service | An attacker triggers thousands of messages or holds workers with slow providers. | Per-identity and per-IP quotas, queue backpressure, bounded exponential backoff with jitter, provider timeouts, and a dead-letter queue. Retries are limited and validation errors are never retried. (#206, #215) |
| Elevation of privilege | A preference bypass sends a disabled channel, or a template chooses a privileged webhook. | Evaluate preferences immediately before dispatch, authorize template selection in the application layer, and keep provider configuration out of user-controlled templates. (#210) |
| SSRF | A user supplies a webhook URL pointing at localhost, cloud metadata, or an internal admin service. | Do not fetch user-provided URLs from the notification worker. Use an allowlisted provider/gateway destination configured by operators; if configurable destinations are introduced, resolve DNS, reject private/link-local ranges after resolution, restrict schemes and ports, and re-check redirects. This is an accepted risk for the current fixed-destination adapter, not permission to add arbitrary webhooks. (#215) |

## Abuse controls and delivery semantics

The queue is the control point for notification bombing. Quotas should be
keyed by the authenticated subject and destination, with a separate global
budget so one subject cannot exhaust all workers. A rejected quota request is
recorded as a policy outcome rather than retried. A provider timeout is
retryable, but the idempotency key remains the notification id so a lost
response cannot create an unbounded duplicate stream.

Templates are code-owned configuration, not user-authored markup. The registry
must fail closed at startup on duplicate or invalid definitions. The renderer
must treat all variables as data. If a future product requirement needs
customer-authored templates, it needs a separate review for HTML sanitization,
content security policy, and per-tenant authorization.

## Residual risk and review checklist

The current design intentionally sends through an operator-configured gateway;
it does not support arbitrary recipient-selected webhook URLs. That removes
the SSRF sink from the current threat surface. Future webhook work must add
network egress controls and signed requests before enabling URLs in the API.

Before release, verify that every send path applies preferences, every retry
has a bounded deadline, delivery bodies are absent from logs, callback
signatures reject replays, and the dead-letter path cannot itself trigger a
notification loop.
