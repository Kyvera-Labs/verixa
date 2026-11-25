# Notifications setup

Notification delivery is intentionally split into a queue boundary and a
delivery adapter. A worker can retry transient failures without making the
request that triggered a notification wait for an external provider.

## Dead letters

When the delivery worker exhausts its retry policy, it should save the original
`NotificationMessage` together with every failed attempt in a `DeadLetterStore`.
The failure history is operational data: it explains whether the provider
timed out, rejected the recipient, or returned an upstream error.

`ReplayDeadLetterNotification` sends the original message back through the
normal `NotificationDeliveryQueue`. It deletes the dead-letter record only
after enqueue succeeds. That ordering is deliberate: a queue outage must not
turn an operator's replay into permanent data loss. The in-memory store is
provided for tests; production deployments should supply durable persistence.
