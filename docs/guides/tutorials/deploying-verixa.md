# Deploying Verixa: current image workflow and deployment readiness

This walkthrough shows what a fresh checkout can do today and identifies the
remaining infrastructure needed for an Internet-facing deployment. A deployment
guide should not promise a production path that the repository cannot execute:
the roadmap defines single-host Compose and PaaS paths, but the corresponding
production files and release workflows are not present yet.

## 1. Get the source and run the local stack

Install Node.js 22.13 or newer, pnpm 11, and Docker Compose. Then:

```bash
git clone https://github.com/Kyvera-Labs/verixa.git
cd verixa
pnpm install --frozen-lockfile
docker compose up -d postgres redis
pnpm db:generate
pnpm db:migrate
pnpm build
pnpm --filter @verixa/api run dev
```

The development services and their ports are defined in
[`docker-compose.yml`](../../../docker-compose.yml). The API's development
command is in [`apps/api/package.json`](../../../apps/api/package.json); its
configuration schema and defaults are in
[`packages/config/index.ts`](../../../packages/config/index.ts). The local
database credentials in Compose are for development only. Do not reuse them on
a public host.

## 2. Build and smoke-test the runtime image

The production bundle is built from the repository root because the API uses
workspace packages:

```bash
docker build -f apps/api/Dockerfile -t verixa-api:local .
docker run --rm -d --name verixa-api -p 3000:3000 \
  -e SESSION_ACCESS_TOKEN_SECRET="replace-with-a-random-secret-of-at-least-32-characters" \
  verixa-api:local
curl --fail http://localhost:3000/health
docker rm -f verixa-api
```

The Dockerfile, including workspace build, production pruning, non-root user,
and runtime entrypoint, is
[`apps/api/Dockerfile`](../../../apps/api/Dockerfile). CI repeats the build,
health check, and runtime assertions in
[`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml). The image
build does not publish an image to a registry.

## 3. What must exist before production deployment

The following roadmap deliverables are not currently implemented, so the repo
does not yet provide a complete, HTTPS-served, monitored production deployment
from a fresh checkout:

- **Single-host stack:** there is no `docker-compose.prod.yml`, persistent
  production database/Redis configuration, backup/restore runbook, or TLS
  reverse proxy. The existing Compose file is explicitly for local development.
- **Migrations on deploy:** `pnpm db:migrate:deploy` exists for a prepared
  environment, but there is no production one-shot Compose service or deploy
  workflow that runs it before API startup.
- **Publishing and rollback:** no container registry workflow or immutable
  release tags are configured. Build the image locally as above; do not expect
  a published `ghcr.io` image or rollback script.
- **PaaS:** no platform manifest or release-phase migration hook is present.
- **Monitoring and TLS:** the container exposes the API on port 3000 and has
  `/health`; public TLS termination, alerting, and an external monitoring
  service must be supplied by an operator and are not configured here.

The roadmap specifications for these pieces are
[Phase 20, issues 385–398](../../../planning/issues/phase-20-docker-deployment.md).
The configuration contract is
[`packages/config/index.ts`](../../../packages/config/index.ts); in particular,
`SESSION_ACCESS_TOKEN_SECRET` is required and must be a strong secret in a real
deployment. The application reads the database and Redis URLs from
`DATABASE_URL` and `REDIS_URL`.

Until those deliverables land, a safe operator should treat the image build as
a CI-verified artifact and run it only behind an independently managed TLS
proxy with managed, backed-up data services. This is an operational workaround,
not the supported single-host or PaaS path promised by Phase 20.

## 4. Vulnerability checks

Both image build workflows scan OS packages and bundled application libraries
for fixed HIGH and CRITICAL vulnerabilities. Reports are archived as
30-day CI artifacts. Unfixed findings remain reportable without blocking; a
waiver for a finding that is fixed must be listed in `.trivyignore` and have a
matching justification and future expiry in
[`infra/ci/trivyignore.yaml`](../../../infra/ci/trivyignore.yaml). The validator
is [`infra/ci/check-trivy-waivers.mjs`](../../../infra/ci/check-trivy-waivers.mjs).
The policy and rationale are described in
[`docs/security/container-hardening.md`](../../security/container-hardening.md).

The scan verifies the image produced by the Dockerfile, rather than source
manifests alone, because runtime OS packages and the deployed dependency tree
are part of the artifact operators actually run.
