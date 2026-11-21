# Observability

## Health-Check Semantics

Verixa separates **liveness** from **readiness** following Kubernetes health-check semantics.

### Liveness (`GET /health/live`)

`GET /health/live` (implemented in `apps/api/src/routes/health/live.ts`) answers one narrow question: **is this Node.js process alive and is its event loop responsive?**

- Returns HTTP `200` with `{ "status": "ok" }`.
- Performs **zero external I/O**: no Postgres queries, no Redis pings, no downstream HTTP calls.
- **Excluded from authentication**: registered outside the authenticated REST scope so orchestrators (Kubernetes `kubelet`, load balancers, container runtimes) can probe it without credentials.
- **Excluded from rate limiting**: configured with `config.rateLimit.skip = true` so high-frequency probes from multiple orchestrator nodes are never throttled with `429 Too Many Requests`.

#### Why liveness never checks dependencies

A common mistake is to check Postgres or Redis inside the liveness probe. That alternative was explicitly rejected because **conflating liveness with dependency health causes cascading restart storms**:

1. Suppose Postgres experiences a brief 5-second failover.
2. If `/health/live` queries Postgres, every healthy API pod fails its liveness probe simultaneously.
3. Kubernetes kills and restarts all API pods at once.
4. When Postgres recovers, a thundering herd of cold-starting pods reconnects simultaneously, prolonging the outage.

A process whose event loop is responsive does **not** need to be restarted because a database is temporarily unreachable — restarting it cannot fix the database.

### Readiness (separate concern)

Dependency checks (Postgres connectivity, Redis availability, migration readiness) belong on a dedicated **readiness** probe, which tells the load balancer to stop routing traffic to a pod without killing the process. Once the dependency recovers, the pod resumes serving traffic immediately with zero restart overhead.
