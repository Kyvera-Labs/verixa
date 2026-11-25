# Observability

## Dashboards-as-Code

Grafana dashboards in Verixa are authored as version-controlled JSON files under `infra/observability/dashboards/` and provisioned automatically into Grafana via `infra/observability/grafana-provisioning/`.

### Why Dashboards-as-Code?

Manually clicked-together Grafana dashboards drift silently, cannot be code-reviewed, and vanish during disaster recovery. Storing dashboard definitions alongside application code gives observability the same guarantees as infrastructure-as-code:

- **Reproducibility**: `docker compose` boots a fresh Grafana instance with datasources and dashboards already wired and populated from live Prometheus metrics.
- **Reviewability**: every PromQL query, threshold, and panel layout change goes through the same pull request review as application code.
- **Disaster recovery**: losing a Grafana volume loses zero dashboard definitions because `editable: false` and `allowUiUpdates: false` keep git as the single source of truth.

### Included Dashboards

| File                                                      | Coverage                                                                                                                                                       |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `infra/observability/dashboards/http-golden-signals.json` | HTTP golden signals (Latency p50/p95/p99, Traffic req/s, 4xx/5xx Errors, Event Loop & Heap Saturation) and `/health` service `up` status                       |
| `infra/observability/dashboards/business-metrics.json`    | Identity registrations, auth login outcomes, active sessions & token revocations, verification attempts, audit log throughput, and readiness dependency health |

### Running Locally

Start Prometheus and Grafana alongside the base development stack:

```bash
docker compose -f docker-compose.yml -f infra/docker/docker-compose.observability.yml up
```

Or start the observability stack standalone to verify provisioning:

```bash
docker compose -f infra/docker/docker-compose.observability.yml up
```

- **Grafana**: `http://localhost:3001` (default credentials `admin` / `admin`, override via `GRAFANA_ADMIN_USER` and `GRAFANA_ADMIN_PASSWORD`)
- **Prometheus**: `http://localhost:9090`

### Rejected Alternatives

- **Manual Grafana UI state with periodic JSON exports**: rejected because ad-hoc edits in the UI diverge from git and break reproducibility.
- **Jsonnet / Grafonnet**: rejected for now to avoid introducing a separate compiler toolchain (`jsonnet`, `jb`) for contributors; plain Grafana JSON is directly diffable, validated in CI by `tests/ci/observability-dashboards.spec.ts`, and requires zero extra local dependencies.
