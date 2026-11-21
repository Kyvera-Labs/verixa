# Observability Guide

Verixa delivers operational observability across three core pillars: structured logging, Prometheus metrics, and OpenTelemetry distributed tracing, underpinned by continuous health checks and correlation ID linkage. This guide documents the design rationale, contracts, and usage patterns for the observability infrastructure introduced in Phase 18 (Issues 341-360, #467, #470, #472).

---

## 1. Architecture Overview: The Observability Seam

Telemetry code (recording counters, measuring durations, setting gauge levels, logging structured events) lives alongside domain rules and application use cases. However, coupling domain or HTTP handlers directly to concrete monitoring vendors (such as `prom-client`, DataDog, or CloudWatch) violates hexagonal architecture and creates high vendor lock-in.

Verixa resolves this by introducing the **Metrics Port** (`MetricsRecorder`) in `@verixa/observability`. Call sites interact exclusively with this typed port. The concrete implementation—whether a zero-allocation test recorder (`NoopMetricsRecorder`) or a production Prometheus exporter (`PrometheusMetricsRecorder`)—is injected at the application boundary (`apps/api/src/composition-root.ts` and `apps/api/src/server.ts`).

```
                    ┌──────────────────────────────┐
                    │      Application Layer       │
                    │   (Routes, Use Cases, Hooks) │
                    └──────────────┬───────────────┘
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │  MetricsRecorder Port (Port) │
                    └──────┬────────────────┬──────┘
                           │                │
            ┌──────────────┴────┐      ┌────┴────────────────┐
            │                   │      │                     │
            ▼                   ▼      ▼                     ▼
┌───────────────────────┐  ┌───────────────────────┐  ┌────────────────────────┐
│  NoopMetricsRecorder  │  │ PrometheusRecorder    │  │ Future Adapters        │
│  (In-Memory Capture)  │  │ (`prom-client`)       │  │ (OTel Metrics, etc.)   │
└───────────────────────┘  └───────────────────────┘  └────────────────────────┘
```

---

## 2. Metrics Port Abstraction (`MetricsRecorder`)

Located at `packages/observability/application/ports/metrics.ts`.

### Method Contracts

- **`incrementCounter(name, value?, labels?)`**: Monotonically increasing metric representing cumulative event occurrences (e.g. `verixa_http_requests_total`, `verixa_auth_login_attempts_total`). `value` defaults to `1` when omitted and must be positive.
- **`recordHistogram(name, value, labels?)`**: Statistical distribution observation representing statistical measurements such as latency in seconds (`verixa_http_request_duration_seconds`) or payload size in bytes.
- **`setGauge(name, value, labels?)`**: Instantaneous numerical value that can go up and down over time, representing saturation or concurrency (e.g. `verixa_http_in_flight_requests`, connection pool occupancy).
- **`incrementGauge(name, value?, labels?)` & `decrementGauge(name, value?, labels?)`**: Helper operations for atomically adjusting gauges.

### Why a Port Seam Instead of Direct Library Imports?

- **Zero Test Friction**: Unit and use case tests run with `NoopMetricsRecorder`, eliminating the need to mock complex Prometheus registries or handle network sockets in test runners.
- **In-Memory Call Capture**: `NoopMetricsRecorder` captures calls in memory so assertions like `expect(recorder.getCounter('verixa_auth_logins_total')).toBe(1)` execute in microseconds.
- **Swappability**: Replacing the metrics collector from Prometheus to OpenTelemetry Metrics or AWS CloudWatch Embedded Metric Format requires changing only one file at the composition root.

> **Design Decision & Rejected Alternative:** We rejected exporting a global singleton function (e.g., `metrics.increment(...)`) directly into use cases. Global singletons hide dependencies, create state leakage between parallel test executions in Vitest, and make it impossible to run multiple instances of the API with isolated registries in the same process.

---

## 3. Prometheus Adapter (`PrometheusMetricsRecorder`)

Located at `packages/observability/infrastructure/prometheus-metrics-recorder.ts`.

Implements `MetricsRecorder` using the official `prom-client` package, registering counters, histograms, and gauges in a shared singleton registry (`getSharedRegistry()`).

### Prometheus Naming Conventions

Metric names follow the OpenMetrics and Prometheus specifications:

- Name format: `^[a-zA-Z_:][a-zA-Z0-9_:]*$`
- Cumulative counters end with `_total` (e.g., `verixa_http_requests_total`).
- Timing durations specify their unit in seconds (e.g., `verixa_http_request_duration_seconds`).
- Latency buckets adhere to Google SRE recommendations for HTTP endpoints: `[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]`.

### Label Cardinality Guards: Protecting Time-Series Databases

In time-series databases like Prometheus or VictoriaMetrics, every unique permutation of metric name and label values creates a distinct time-series stream in memory and on disk. Introducing unbounded labels (such as user IDs, email addresses, session tokens, or transaction hashes) results in a **cardinality explosion**: Prometheus memory usage spikes exponentially until the process crashes (OOM) or scraping grinds to a halt.

`PrometheusMetricsRecorder` enforces runtime cardinality guards that throw `CardinalityGuardError`:

1. **Forbidden Label Keys**: Rejects label keys known to contain unbounded identifiers (e.g., `userId`, `user_id`, `sub`, `email`, `token`, `sessionId`, `ip`, `trace_id`).
2. **Unbounded Value Detection**: Rejects values that match UUID formats (`/^[0-9a-f]{8}-.../`), valid email addresses (`user@domain.com`), JWT tokens, or strings longer than 120 characters.
3. **Metric Stream Ceiling**: Caps the maximum number of distinct label permutations allowed per metric (default: 1000) to protect against accidental cardinality leakage under heavy production load.

```typescript
import { PrometheusMetricsRecorder } from "@verixa/observability";

const recorder = new PrometheusMetricsRecorder();

// OK: Low-cardinality discrete dimensions
recorder.incrementCounter("verixa_http_requests_total", {
  method: "GET",
  route: "/users/:id",
  status_class: "2xx",
});

// THROW CardinalityGuardError: Unbounded label key
recorder.incrementCounter("verixa_http_requests_total", {
  userId: "12345",
});

// THROW CardinalityGuardError: UUID in label value
recorder.incrementCounter("verixa_events_total", {
  entity_id: "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
});
```

---

## 4. HTTP Request Metrics Middleware

Located at `apps/api/src/plugins/http-metrics.ts` and re-exported at `apps/api/plugins/http-metrics.ts`.

Fastify request lifecycle hooks automatically instrument every HTTP endpoint without requiring per-route boilerplate.

### The Four Golden Signals

As outlined in the Google SRE handbook, the four golden signals of monitoring are latency, traffic, errors, and saturation. Verixa's HTTP middleware captures all four:

| Signal         | Metric Name                                      | Type      | Description                                               |
| -------------- | ------------------------------------------------ | --------- | --------------------------------------------------------- |
| **Traffic**    | `verixa_http_requests_total`                     | Counter   | Total count of handled requests                           |
| **Latency**    | `verixa_http_request_duration_seconds`           | Histogram | Execution duration from request arrival to response flush |
| **Errors**     | `verixa_http_requests_total{status_class="5xx"}` | Counter   | Measured via the `status_class` label (`4xx`, `5xx`)      |
| **Saturation** | `verixa_http_in_flight_requests`                 | Gauge     | Currently executing in-flight HTTP requests               |

### Fastify Route Template vs. Raw Path

A common error in HTTP metrics middleware is labeling requests with the raw URL path (e.g., `req.url` -> `/users/12345`). Since user IDs and UUIDs vary with every customer, this causes immediate metric cardinality degradation.

Verixa extracts `request.routeOptions.url`, which contains Fastify's route schema pattern:

- A request to `/users/98765` is recorded with `route="/users/:id"`.
- A request to `/organizations/org_1/members/usr_2` is recorded with `route="/organizations/:orgId/members/:memberId"`.
- Requests to unregistered endpoints (404s) are recorded with `route=":unmatched"`, preventing attackers from generating infinite metrics by hitting random URLs.

### Hook Lifecycle

```
Client Request
      │
      ▼
onRequest Hook:
  ├─ Capture start time: process.hrtime.bigint()
  └─ inFlightRequests++ -> setGauge("verixa_http_in_flight_requests", count)
      │
      ▼
Route Execution & Response
      │
      ▼
onResponse Hook:
  ├─ inFlightRequests-- -> setGauge("verixa_http_in_flight_requests", count)
  ├─ duration = (now - start) / 1e9
  ├─ recordHistogram("verixa_http_request_duration_seconds", duration, { method, route, status_class })
  └─ incrementCounter("verixa_http_requests_total", 1, { method, route, status_class })
```

---

## 5. OpenTelemetry Bootstrap & Resource Attributes

Located at `packages/observability/infrastructure/otel-bootstrap.ts` and loaded by `apps/api/src/instrumentation.ts`.

### Why SDK Initialization Must Occur at Process Start

OpenTelemetry auto-instrumentation operates by patching Node's module resolution and loader hooks (`require` / ESM loaders) to wrap core modules (such as `node:http`, Fastify, Prisma, Redis) before their classes are instantiated.

If an application imports database or network modules _before_ `NodeSDK.start()` runs, those modules bypass the monkey-patching hooks and will not emit spans. Therefore:

1. `apps/api/src/instrumentation.ts` initializes OpenTelemetry at the entrypoint.
2. `apps/api/src/server.ts` imports `./instrumentation.js` as its very first statement.
3. Node process launches can also use `--import ./dist/instrumentation.js`.

### Standard Resource Attributes

Every span emitted by the tracing engine is tagged with standard semantic conventions:

| Attribute                | Source                                    | Description                              |
| ------------------------ | ----------------------------------------- | ---------------------------------------- |
| `service.name`           | `OTEL_SERVICE_NAME` or `verixa-api`       | Identifies the logical service name      |
| `service.version`        | `SERVICE_VERSION` or `0.1.0`              | Semantic version of the service          |
| `deployment.environment` | `NODE_ENV` (e.g. `production`, `staging`) | Deployment tier                          |
| `deployment.id`          | `DEPLOYMENT_ID` or hostname/UUID          | Unique instance/container identifier     |
| `service.instance.id`    | Same as `deployment.id`                   | OpenTelemetry standard instance identity |

### Test Environment Cleanliness

Running full OpenTelemetry background exporters in test environments (`NODE_ENV === 'test'`) pollutes CI outputs with unhandled connection errors (`connect ECONNREFUSED ::1:4318`) when no OTLP collector is present.

`initOtelBootstrap()` handles this cleanly:

- When `NODE_ENV === 'test'`, the SDK defaults to an inactive no-op state (`active: false, reason: "disabled_in_test_environment"`).
- In tests specifically exercising OTel behavior, `forceEnable: true` enables an in-memory exporter (`MemorySpanExporter`) that records spans synchronously without attempting network connections.

---

## 6. Pillars Cross-Linking: Correlation ID & Trace ID Linkage

Located at `packages/observability/infrastructure/request-context.ts` and `apps/api/src/plugins/request-context.ts` (Issue 355 / #467).

### The Three Pillars Disconnection Problem

Historically, logging, metrics, and tracing operate as isolated silos:

1. Logs show what happened locally in human-readable messages.
2. Metrics show high-level aggregates (e.g. 5xx rate spiked to 12%).
3. Distributed traces show cross-network timings between microservices.

Without an unambiguous linkage identifier, triaging an incident is painfully slow: an operator sees a 500 error in Prometheus, finds a user's `X-Request-Id` in customer support, but cannot find the matching distributed trace in Jaeger/Tempo or the matching database log line.

### Unified Linkage Architecture

Verixa solves this by binding the OpenTelemetry `traceId` and the HTTP correlation `requestId` together in an asynchronous context (`AsyncLocalStorage`):

```
HTTP Request (Inbound headers: X-Request-Id, traceparent, X-Trace-Id)
                       │
                       ▼
             [request-context plugin]
  ┌──────────────────────────────────────────────────┐
  │ 1. Extract/generate correlation ID (UUIDv4)      │
  │ 2. Extract/inherit W3C traceparent or OTel span  │
  │ 3. Store in AsyncLocalStorage RequestContext     │
  └────────────────────┬─────────────────────────────┘
                       │
        ┌──────────────┴──────────────┐
        ▼                             ▼
┌────────────────┐            ┌────────────────┐
│ Structured Log │            │ Error Response │
│ Mixin Injection│            │ & Headers Echo │
└───────┬────────┘            └───────┬────────┘
        │                             │
        ▼                             ▼
  {"level": 50,                 HTTP 500 Internal Error
   "msg": "DB fail",            Headers:
   "req": {"id": "corr-1"},       X-Request-Id: corr-1
   "trace": {"id": "trace-1"}}    X-Trace-Id: trace-1
                                Body:
                                {"error": {
                                   "requestId": "corr-1",
                                   "traceId": "trace-1"
                                }}
```

### Context Propagation via `AsyncLocalStorage`

Rather than threading `requestId` and `traceId` through every use case, entity, and domain service signature, `runWithRequestContext` stores request metadata in Node's native `AsyncLocalStorage`.

```typescript
import { runWithRequestContext, getCorrelationId, getActiveTraceId } from "@verixa/observability";

await runWithRequestContext(
  { correlationId: "req-123", traceId: "4bf92f3577b34da6a3ce929d0e0e4736" },
  async () => {
    // Accessible anywhere in the call stack across async boundaries:
    const corrId = getCorrelationId(); // "req-123"
    const traceId = getActiveTraceId(); // "4bf92f3577b34da6a3ce929d0e0e4736"
  },
);
```

### Automatic Pino Mixin Injection

`createContextualLogger` configures Pino with a dynamic `mixin` function. Whenever any subsystem calls `logger.info("message")`, the logger inspects `getRequestContext()` and injects:

- `req.id`: Correlation ID (`requestId`).
- `trace.id`: OpenTelemetry trace identifier (`traceId`).
- `actor.id`: Authenticated principal ID if authenticated.

> **Design Decision & Rejected Alternative:** We rejected explicitly passing the logger as a parameter into every domain function or attaching IDs manually at every `logger.info` invocation. Manual attachment is error-prone, violates domain cleanliness, and invariably leads to unlinked log lines during unexpected exceptions.

---

## 7. Health Check System & Dependency Probes

Located at `packages/observability/application/health-check-registry.ts` and `apps/api/src/routes/health.ts` (Issue 358 / #470).

### Liveness vs. Readiness Probes

Container orchestrators (Kubernetes, AWS ECS, Nomad) require distinct signals to manage pod lifecycles:

| Probe         | Endpoint            | Behaviour                                                                                | Orchestrator Action on Failure                                      |
| :------------ | :------------------ | :--------------------------------------------------------------------------------------- | :------------------------------------------------------------------ |
| **Liveness**  | `GET /health/live`  | Process is up, event loop responsive, no deadlocks. Does NOT ping external dependencies. | Kill container and restart it.                                      |
| **Readiness** | `GET /health/ready` | Verifies critical dependencies (PostgreSQL via `SELECT 1`, Redis via `PING`).            | Remove pod from service load balancer traffic pool; do NOT restart. |

> **Critical Operational Warning:** Never check external databases or caches inside the **liveness** endpoint (`/health/live`). If a database experiences a transient outage or restart, checking it in liveness causes every single API pod to restart simultaneously, triggering a catastrophic crash loop and preventing graceful recovery.

### Health Check Registry & Timeouts

The `HealthCheckRegistry` manages registered dependency checks with strict per-check timeout bounding:

```typescript
import {
  HealthCheckRegistry,
  createPostgresHealthCheck,
  createRedisHealthCheck,
} from "@verixa/observability";

const registry = new HealthCheckRegistry({ defaultTimeoutMs: 3000 });

registry.register("postgres", createPostgresHealthCheck(prismaClient));
registry.register("redis", createRedisHealthCheck(redisClient));

const report = await registry.check();
// report.status === "healthy" | "degraded"
```

- When all dependencies succeed: HTTP 200 OK.
- When any dependency fails or exceeds the timeout (e.g. 3000ms): HTTP 503 Service Unavailable with details specifying the degraded service and error message.

---

## 8. Composition Root Wiring & Environment Tiers

Located at `apps/api/src/composition/observability.ts` and `apps/api/src/composition-root.ts` (Issue 360 / #472).

Cross-cutting infrastructure must be instantiated once at the composition root and injected into application services.

### Environment Matrix

| Component         | Production / Staging                           | Test (`NODE_ENV === 'test'`)              |
| :---------------- | :--------------------------------------------- | :---------------------------------------- |
| **Logger**        | Pino structured JSON output with context mixin | Pino silent or minimal logger             |
| **Metrics**       | `PrometheusMetricsRecorder`                    | `NoopMetricsRecorder` (in-memory capture) |
| **Tracing**       | `initOtelBootstrap()` with OTLP/HTTP exporter  | No-op disabled tracer                     |
| **Health Checks** | Live Prisma (`SELECT 1`) & Redis (`PING`)      | Memory stub health checks                 |

For a step-by-step tutorial on adding observability to a new service following Verixa conventions, see [Tutorial: Adding Observability to a Service](docs/guides/tutorials/adding-observability-to-a-service.md).
