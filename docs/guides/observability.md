# Observability Guide

Verixa delivers operational observability across three core pillars: structured logging, Prometheus metrics, and OpenTelemetry distributed tracing. This guide documents the design rationale, contracts, and usage patterns for the metrics and tracing infrastructure introduced in Phase 18 (Issues 347, 348, 349, and 352).

---

## 1. Architecture Overview: The Observability Seam

Telemetry code (recording counters, measuring durations, setting gauge levels) lives alongside domain rules and application use cases. However, coupling domain or HTTP handlers directly to concrete monitoring vendors (such as `prom-client`, DataDog, or CloudWatch) violates hexagonal architecture and creates high vendor lock-in.

Verixa resolves this by introducing the **Metrics Port** (`MetricsRecorder`) in `@verixa/observability`. Call sites interact exclusively with this typed port. The concrete implementation—whether a zero-allocation test recorder (`NoopMetricsRecorder`) or a production Prometheus exporter (`PrometheusMetricsRecorder`)—is injected at the application boundary (`apps/api/src/server.ts`).

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
