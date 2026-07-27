# Logging

`@verixa/shared-kernel` exports `createLogger()`
(`packages/shared-kernel/infrastructure/logger.ts`), a thin wrapper around
[pino](https://getpino.io/) that every part of the codebase should use
instead of `console.log`. `apps/api` passes it to Fastify via
`loggerInstance`, which gives every request its own child logger
automatically.

## Usage

```ts
import { createLogger } from "@verixa/shared-kernel";

const logger = createLogger({ name: "verixa-api", level: config.LOG_LEVEL });

logger.info("server started");
logger.info({ userId }, "user registered");
```

Request-scoped logging doesn't need any special API — it's the standard pino
`.child()` method, which Fastify calls internally per request when you pass
`loggerInstance`:

```ts
const requestLogger = logger.child({ reqId: request.id });
requestLogger.info("processing payment"); // includes reqId automatically
```

## Structured vs. unstructured logging

`console.log("user", userId, "logged in")` produces a string that's only
useful to a human reading it live. In production, logs get aggregated,
searched, and alerted on by machines — a structured logger emits one JSON
object per line instead:

```json
{
  "level": 30,
  "time": 1706000000000,
  "name": "verixa-api",
  "userId": "...",
  "msg": "user logged in"
}
```

That's queryable (`level:50 AND userId:"abc"`), aggregable (count errors per
`name` across services), and machine-parseable without regex archaeology.
Structured logging is a prerequisite for the observability work in Phase 18
(metrics, tracing, correlation IDs) — none of that is retrofittable onto
freeform string logs.

## Why redaction matters

Logging a secret is one of the most common real-world causes of a credential
leak — not because someone meant to, but because a debug `logger.info(req.body)`
or `logger.error(error)` (where `error` happens to carry a password field)
ends up shipping to a log aggregator that's far less access-controlled than
the database the secret came from, and logs are frequently retained (and
backed up, and replicated to search indices) for much longer than anyone
intended. Unlike a database leak, a log leak often isn't even noticed as a
"breach" — it just quietly sits there, searchable, until someone finds it.

`createLogger()` pre-configures pino's `redact` option with paths covering
`password`, `token`, `accessToken`, `refreshToken`, `secret`, `apiKey`, and
the `Authorization`/`Cookie` headers, at both the top level and one level of
nesting — so `logger.info({ password: "hunter2" }, "login attempt")` emits
`{"password":"[REDACTED]", ...}`, never the real value. Redaction applies
automatically to child loggers too (see `logger.spec.ts`).

**Redaction is a safety net, not a license to log secrets on purpose.**
Passing a whole request/user object to the logger "because redaction will
catch it" is still worse practice than logging only the fields you actually
need — the redact list can't cover a field name nobody thought of. When you
add a new kind of secret to the codebase, add its field name to
`DEFAULT_REDACT_PATHS` (or pass `redact` to `createLogger()` for something
call-site-specific) in the same change.

## Configuration

The log level comes from `LOG_LEVEL` via `@verixa/config` (see
[`docs/guides/configuration.md`](configuration.md)) — never hardcode a level
in application code.
