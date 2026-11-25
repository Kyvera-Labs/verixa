# Incident Response Runbook

This runbook guides on-call engineers and operators through identifying, triaging, and diagnosing operational incidents across Verixa services using the unified observability pillars (Issue 355 / #467, Issue 358 / #470).

---

## 1. Triaging an Error from Customer Reports or Support

When a client or frontend application encounters an HTTP error (4xx or 5xx), the response body and headers include correlation and tracing identifiers:

```http
HTTP/1.1 500 Internal Server Error
Content-Type: application/json; charset=utf-8
x-request-id: 7fa98b5a-1b4d-44a3-83f1-4db52a829e1f
x-trace-id: 4bf92f3577b34da6a3ce929d0e0e4736

{
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "An unexpected error occurred processing your request.",
    "requestId": "7fa98b5a-1b4d-44a3-83f1-4db52a829e1f",
    "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
  }
}
```

### Navigating from Request ID / Trace ID to Structured Logs

All structured log records generated during the lifecycle of the request are automatically tagged with `req.id` (or `requestId`) and `trace.id` (or `traceId`).

To locate all logs for an incident in log aggregators (e.g., Elasticsearch, Loki, Datadog):

**Query by Correlation ID:**

```
req.id:"7fa98b5a-1b4d-44a3-83f1-4db52a829e1f" OR requestId:"7fa98b5a-1b4d-44a3-83f1-4db52a829e1f"
```

**Query by OpenTelemetry Trace ID:**

```
trace.id:"4bf92f3577b34da6a3ce929d0e0e4736" OR traceId:"4bf92f3577b34da6a3ce929d0e0e4736"
```

### Navigating from Trace ID to Distributed Tracing (Jaeger / Grafana Tempo)

1. Open your distributed tracing viewer (e.g. Grafana Tempo, Jaeger, AWS X-Ray).
2. Enter the 32-character hexadecimal trace ID (`4bf92f3577b34da6a3ce929d0e0e4736`).
3. View the complete waterfall span breakdown:
   - Inbound HTTP request route and duration.
   - Database queries executed (Prisma / PostgreSQL spans).
   - Redis cache operations.
   - External network calls (e.g. Stellar anchor, email webhooks).
4. Identify which child span threw an error or exceeded latency budgets.

---

## 2. Health Check Degradation & Probe Failures

Verixa exposes dual health endpoints for orchestrator integration:

- `GET /health/live` (Liveness probe)
- `GET /health/ready` (Readiness probe)

### Triage Matrix

| Signal                                       | Probable Cause                                                                      | Action                                                                                                                                                                                                                                                                                 |
| :------------------------------------------- | :---------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Readiness 503 (`/health/ready`)**          | Downstream dependency failure (PostgreSQL connection pool exhausted or Redis down). | 1. Check `/health/ready` response payload for failing check (`checks.postgres` or `checks.redis`).<br>2. Inspect database connection metrics (`verixa_db_pool_active`).<br>3. Traffic is automatically removed from this pod by the load balancer; do NOT restart the pod immediately. |
| **Liveness 503 or Timeout (`/health/live`)** | Event loop starvation, memory exhaustion (OOM), or fatal deadlock.                  | Pod will be automatically terminated and restarted by the orchestrator. If restarts recur, check Node.js heap dumps and CPU profiling.                                                                                                                                                 |

### Recommended Orchestrator Probe Configuration (Kubernetes / ECS)

```yaml
livenessProbe:
  httpGet:
    path: /health/live
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 10
  timeoutSeconds: 2
  failureThreshold: 3

readinessProbe:
  httpGet:
    path: /health/ready
    port: 3000
  initialDelaySeconds: 10
  periodSeconds: 5
  timeoutSeconds: 3
  failureThreshold: 2
```

### Deployment Rollback Guidance

If a new deployment rollout causes `/health/ready` to return 503 across new pods:

1. Orchestrators configured with readiness probes will halt progressive deployment (canary / rolling update) because new pods never transition to ready.
2. If old pods were terminated or error rates spike, execute an immediate rollback:
   ```bash
   kubectl rollout undo deployment/verixa-api
   ```
3. Check the readiness response to pinpoint whether database schema migrations failed:
   ```bash
   curl -s http://localhost:3000/health/ready | jq .
   ```

---

## 3. Investigating Metric Spikes in Prometheus

When alerts fire on high error rates (`verixa_http_requests_total{status_class="5xx"}`) or latency (`verixa_http_request_duration_seconds`):

1. Identify the impacted route using Prometheus labels:
   ```promql
   sum by (route, status_class) (rate(verixa_http_requests_total[5m]))
   ```
2. Check in-flight saturation:
   ```promql
   verixa_http_in_flight_requests
   ```
3. Correlate with logs using the affected route pattern (e.g., `route="/v1/sessions"`).
