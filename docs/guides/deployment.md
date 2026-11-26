# Deployment Guide

This guide documents Verixa's production deployment architecture, environment
configuration matrix, per-environment configuration templates, and container
runtime guarantees.

Verixa follows the **Twelve-Factor App** methodology: strict separation of config
from code, declarative configuration via environment variables, stateless disposable
processes with fast startup and graceful shutdown, and parity between development,
testing, staging, and production environments.

---

## Environment Configuration Matrix

The matrix below is the single source of truth for all environment variables consumed
by `@verixa/config` (defined in `packages/config/schema.ts`), as well as supplementary
runtime keys (such as `TOKEN_SIGNING_KEYS`).

Every configuration variable falls into one of two operational tiers:

1. **Plain Configuration**: Non-sensitive settings (ports, hostnames, log levels,
   timeouts, pool sizes, CORS origins). These may be stored in plain text, version-controlled
   deployment manifests, Helm values, or platform environment variables.
2. **Secrets**: Cryptographic key material, access tokens, database credentials,
   and encryption keys. **Secrets must never be stored in plain text or committed
   to source control.** In staging and production, secrets must be injected at runtime
   from a dedicated secrets manager (AWS Secrets Manager, HashiCorp Vault, Doppler,
   GCP Secret Manager, or sealed Kubernetes Secrets).

To prevent documentation drift, this matrix is continuously validated in CI by
`infra/ci/check-env-matrix.ts`. Any addition to `packages/config/schema.ts` that is
not documented in this matrix will fail the CI build.

### Configuration Matrix Table

| Variable                          | Type / Constraints                                     | Secret? | Development                                      | Test                                                  | Staging                           | Production                     | Description & Reference                                                                                             |
| :-------------------------------- | :----------------------------------------------------- | :-----: | :----------------------------------------------- | :---------------------------------------------------- | :-------------------------------- | :----------------------------- | :------------------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`                        | `enum(development, test, production)`                  |   No    | `development`                                    | `test`                                                | `production`                      | `production`                   | Node execution environment. Governs logging verbosity, HSTS header emission, and error serialization.               |
| `PORT`                            | `integer (1-65535)`                                    |   No    | `3000`                                           | `3000` (ephemeral in tests)                           | `3000`                            | `3000`                         | TCP port the Fastify HTTP server binds and listens on.                                                              |
| `HOST`                            | `string`                                               |   No    | `0.0.0.0`                                        | `127.0.0.1`                                           | `0.0.0.0`                         | `0.0.0.0`                      | Network interface to bind. `0.0.0.0` inside containers; `127.0.0.1` for restricted local execution.                 |
| `LOG_LEVEL`                       | `enum(trace, debug, info, warn, error, fatal, silent)` |   No    | `info` (or `debug`)                              | `silent`                                              | `info`                            | `info` (or `warn`)             | Minimum log level for Pino structured logger. `silent` in unit test runs.                                           |
| `DATABASE_URL`                    | `url`                                                  |   Yes   | `postgres://verixa:verixa@localhost:5432/verixa` | `postgres://verixa:verixa@localhost:5432/verixa_test` | Injected from Secrets Manager     | Injected from Secrets Manager  | Postgres connection string. Must target unprivileged `verixa_app` role in production.                               |
| `DATABASE_POOL_SIZE`              | `integer (1-100)`                                      |   No    | `10`                                             | `5`                                                   | `10`                              | `20` (sized to replica count)  | Maximum pool connections per instance. Sized by `(peak concurrent DB requests) / (app instances)`.                  |
| `DATABASE_POOL_TIMEOUT_SECONDS`   | `integer (1-300)`                                      |   No    | `10`                                             | `5`                                                   | `10`                              | `10`                           | Maximum seconds to wait for an available pool connection before shedding load with an error.                        |
| `REDIS_URL`                       | `url`                                                  |   Yes   | `redis://localhost:6379`                         | `redis://localhost:6379`                              | Injected from Secrets Manager     | Injected from Secrets Manager  | Redis connection string used for session revocation deny-list (`RedisRevocationList`).                              |
| `SESSION_ACCESS_TOKEN_SECRET`     | `string (min 32 chars)`                                |   Yes   | Generated locally (`openssl rand -base64 48`)    | Test dummy (`a`.repeat(32))                           | Injected from Secrets Manager     | Injected from Secrets Manager  | HMAC secret key used by `@verixa/sessions` for signing access tokens. No default in code.                           |
| `SESSION_MAX_CONCURRENT_SESSIONS` | `integer (min 0)`                                      |   No    | `0` (disabled)                                   | `0` (disabled)                                        | `5`                               | `5`                            | Concurrency ceiling for simultaneous sessions per user. `0` disables session eviction.                              |
| `HSTS_MAX_AGE_SECONDS`            | `integer (0-63072000)`                                 |   No    | `31536000` (inert in non-prod)                   | `31536000` (inert)                                    | `31536000` (1 year)               | `31536000` (1 year)            | `Strict-Transport-Security` max-age. Only sent when `NODE_ENV=production`. Capped at 2 years.                       |
| `HSTS_INCLUDE_SUBDOMAINS`         | `boolean (true, false, 1, 0)`                          |   No    | `true`                                           | `true`                                                | `true`                            | `true`                         | Appends `includeSubDomains` to HSTS header. Requires all subdomains to serve valid TLS.                             |
| `HSTS_PRELOAD`                    | `boolean (true, false, 1, 0)`                          |   No    | `false`                                          | `false`                                               | `false`                           | `false` (until submitted)      | Appends `preload` to HSTS directive. Permanent commitment to HTTPS across all domains.                              |
| `ENFORCE_HTTPS`                   | `boolean (true, false, 1, 0)`                          |   No    | `false`                                          | `false`                                               | `false` (handled by LB)           | `false` (or `true` if exposed) | Issues 308 redirect for plaintext HTTP. Typically handled by edge reverse proxy / load balancer.                    |
| `TRUST_PROXY`                     | `boolean (true, false, 1, 0)`                          |   No    | `false`                                          | `false`                                               | `true`                            | `true`                         | Instructs Fastify to trust `X-Forwarded-Proto` and `X-Forwarded-For` from upstream ingress/proxy.                   |
| `CORS_ALLOWED_ORIGINS`            | `comma-separated urls or *`                            |   No    | `""` (empty denies all)                          | `""`                                                  | `https://staging-app.example.com` | `https://app.example.com`      | Allowlist of origins permitted for cross-origin browser requests. `*` forbidden with credentials.                   |
| `CORS_ALLOW_CREDENTIALS`          | `boolean (true, false, 1, 0)`                          |   No    | `false`                                          | `false`                                               | `false`                           | `false`                        | Emits `Access-Control-Allow-Credentials: true`. Refused when `CORS_ALLOWED_ORIGINS` is `*`.                         |
| `MFA_ENFORCEMENT_LEVEL`           | `enum(required, optional, disabled)`                   |   No    | `optional`                                       | `optional`                                            | `optional`                        | `required`                     | Global baseline MFA enforcement. Tenant and user overrides take precedence at runtime.                              |
| `MFA_ALLOWED_METHODS`             | `comma-separated methods`                              |   No    | `totp,webauthn,backup-codes`                     | `totp,webauthn,backup-codes`                          | `totp,webauthn,backup-codes`      | `totp,webauthn,backup-codes`   | Permitted MFA factors globally. Restrict e.g. to `webauthn` for phishing-resistant factor mandates.                 |
| `OTEL_SERVICE_NAME`               | `string (min 1 char)`                                  |   No    | `verixa-api`                                     | `verixa-api`                                          | `verixa-api`                      | `verixa-api`                   | Service name attached to OpenTelemetry trace resource attributes.                                                   |
| `METRICS_ENABLED`                 | `boolean (true, false, 1, 0)`                          |   No    | `false`                                          | `false`                                               | `false`                           | `false`                        | Serves Prometheus metrics at `GET /metrics`. Unauthenticated, so enable it only where an internal scraper needs it. |
| `OTEL_EXPORTER_OTLP_ENDPOINT`     | `optional http/https url`                              |   No    | `""` (or `http://localhost:4318`)                | `""` (disabled)                                       | `http://otel-collector:4318`      | `http://otel-collector:4318`   | Collector-agnostic OTLP exporter endpoint (Jaeger, Tempo, OTel Collector). Empty disables export.                   |
| `OTEL_EXPORTER_OTLP_PROTOCOL`     | `enum(http/protobuf, http/json, grpc)`                 |   No    | `http/protobuf`                                  | `http/protobuf`                                       | `http/protobuf`                   | `http/protobuf`                | OTLP exporter transport protocol. Invalid protocols fail fast at startup.                                           |
| `OTEL_EXPORTER_OTLP_HEADERS`      | `comma-separated key=value`                            |   No    | `""`                                             | `""`                                                  | `""` (or collector auth headers)  | Injected if auth required      | Optional headers sent with OTLP export requests (e.g. `Authorization=Bearer ...`).                                  |
| `OTEL_TRACES_SAMPLER_RATE`        | `number (0-1)`                                         |   No    | `1.0` (100%)                                     | `0.0` (0%)                                            | `0.25`                            | `0.1` (10%)                    | Head-based probabilistic trace sampling rate. Error spans are always force-sampled regardless of rate.              |

---

## Environment-Specific Configuration Templates

Verixa provides explicit, environment-specific configuration templates to eliminate
first-run setup friction and prevent cross-environment misconfigurations:

- **`.env.example`** (Local Development):
  Configured for developer ergonomics out of the box with `docker compose up`. Points
  to local Postgres and Redis instances. All secrets use clear placeholder values with
  instructions for generating local development keys with `openssl`.
- **`.env.test.example`** (Local & CI Testing):
  Configured for automated test runs. Points to isolated databases (`verixa_test`) so
  running tests never mutates development state. Log level is set to `silent` to avoid
  cluttering test runner output.
- **`.env.staging.example`** (Pre-Production Staging):
  Mirrors production security settings (`NODE_ENV=production`, strict TLS, `TRUST_PROXY=true`,
  explicit CORS allowlists). References secret-manager paths for credentials rather than
  embedding real secrets.
- **`.env.production.example`** (Production Deployments):
  Hardened production configuration template. High-entropy signing keys, strict CORS,
  mandatory MFA baselines, and secret-manager placeholder references.

### Placeholder Substitution Rules

Templates in source control use standardized placeholders for sensitive values:

- `SESSION_ACCESS_TOKEN_SECRET`: `change-this-to-a-secure-random-secret-at-least-32-chars`
- `DATABASE_URL`: `postgres://<db_user>:<db_password>@<db_host>:5432/<db_name>`
- `REDIS_URL`: `redis://:<redis_password>@<redis_host>:6379`
- `TOKEN_SIGNING_KEYS`: `[{"kid":"key-id","algorithm":"RS256","publicKey":"<SPKI PEM>","privateKey":"<PKCS#8 PEM>","current":true}]`

In automated deployment pipelines, CI checks (`tests/integration/env-templates.spec.ts`)
verify that every template parses successfully through the Zod schema when placeholder
values are loaded, guaranteeing templates never drift from schema definitions.

---

## Graceful Shutdown & Container Signal Handling

In modern cloud orchestration (Kubernetes, AWS ECS, Nomad, Docker Swarm), zero-downtime
deployments require application processes to shut down gracefully when a container
is stopped or replaced:

```
[Orchestrator] -- SIGTERM --> [apps/api (PID 1)]
                                  │
                                  ├─ 1. Stop accepting new connections
                                  ├─ 2. Complete active in-flight requests
                                  ├─ 3. Flush audit write queues
                                  ├─ 4. Disconnect Prisma & Redis pools
                                  └─ 5. Exit cleanly with code 0
```

### The PID 1 Problem in Containers

In Linux containers, the entrypoint process is assigned **PID 1**.
PID 1 has special kernel semantics:

1. **Signal Swallowing**: Unlike ordinary processes, PID 1 does not receive default
   signal handlers for `SIGTERM` or `SIGINT`. If a Node.js application running as PID 1
   does not explicitly register a signal listener (`process.on('SIGTERM', ...)`),
   the kernel discards the signal.
2. **The Shell Wrapper Pitfall**: If a Dockerfile specifies shell form:
   ```dockerfile
   # ANTI-PATTERN: Spawns /bin/sh -c
   CMD node dist/server.js
   ```
   `/bin/sh` runs as PID 1, and `node` runs as a child process. Standard shells do not
   forward signals to child processes. When the orchestrator sends `SIGTERM`, `/bin/sh`
   swallows it; Node never sees the signal, continues handling traffic unaware, and is
   eventually killed abruptly with `SIGKILL` after the stop timeout.

Verixa eliminates this problem by using exec-form `ENTRYPOINT` in `apps/api/Dockerfile`:

```dockerfile
ENTRYPOINT ["node", "dist/server.js"]
```

This guarantees `node` is PID 1 directly, with no shell process interposed.

### Bounded Grace Period & Connection Draining

When `SIGTERM` or `SIGINT` is received, `apps/api` executes a coordinated shutdown sequence
managed by `createShutdownHandler` in `apps/api/src/server.ts`:

1. **Re-entrancy Protection**: Duplicate signals received while shutdown is already in
   progress are ignored.
2. **Bounded Grace Period (`DEFAULT_SHUTDOWN_TIMEOUT_MS = 10,000`)**:
   A fail-safe timer (10 seconds, matching Docker's default stop timeout) is initialized.
   If in-flight requests or network teardowns hang, the timer triggers `process.exit(1)`
   to prevent zombie container hangs.
3. **HTTP Server Draining**: `app.close()` stops the Fastify HTTP server from accepting
   new TCP connections and allows in-flight requests to complete.
4. **Storage & Queue Draining**: `container.dispose()` flushes any pending entries in
   `BatchedAuditWriter` to prevent data loss and disconnects Prisma (`prisma.$disconnect()`).
5. **Clean Exit**: Once all teardown steps complete, the timer is cleared and the process
   exits with code 0.
   This guide details the supported production deployment paths for Verixa:

6. **Single-Host Deployment (Docker Compose):** Self-hosted or virtual machine deployment via `docker-compose.prod.yml`.
7. **Platform-as-a-Service (PaaS / Fly.io):** Managed container deployment via `infra/docker/platform.toml`.

It also details production requirements for secrets management, pre-deploy migrations, the forward-only migration policy, and the zero-downtime expand/contract schema evolution checklist.

---

## 1. Single-Host Deployment (Docker Compose)

The single-host deployment path orchestrates the full production stack on a single Linux host using Docker and Docker Compose. `docker-compose.prod.yml` is an **overlay**, applied with `-f docker-compose.yml -f docker-compose.prod.yml`: the base file stays readable for development, and the overlay resets only what production genuinely differs on — published ports, the hot-reload command, the source bind-mount and the working directory. Compose merges maps but keeps sequence entries unless they are reset, so those `!reset` lines are load-bearing; removing one silently brings back a dev port or the host source tree.

Every service declares CPU and memory limits. On a single host, a runaway process is not isolated by a scheduler — without limits it can starve Postgres, Redis and the proxy on the same kernel, turning a bug in one container into a total outage.

### Topology

```mermaid
flowchart TD
    Internet([Incoming Traffic]) -->|Ports 80/443| Proxy["proxy (Nginx Reverse Proxy)"]
    Proxy -->|Port 3000| API["api (apps/api Production Image)"]
    API -->|Port 5432 / RLS| Postgres[("postgres (PostgreSQL 16)")]
    API -->|Port 6379| Redis[("redis (Redis 7)")]
    Migration["migration (Prisma Deploy Runner)"] -->|DDL Migration| Postgres
    Migration -.->|Completed Successfully| API
```

### Components

- **`postgres`:** PostgreSQL 16 Alpine container with persistent volume storage (`verixa-prod-postgres-data`) and initial roles configured (`infra/postgres/02-init-app-role.sh`).
- **`redis`:** Redis 7 Alpine cache and rate-limiting store with AOF persistence enabled (`verixa-prod-redis-data`).
- **`migration`:** One-off ephemeral service running `./infra/docker/scripts/migrate.sh` (`pnpm --filter @verixa/database run db:migrate:deploy`). It uses Prisma to safely apply pending database schema migrations before API containers launch.
- **`api`:** Hardened, unprivileged (UID 10001) Node.js 22 runtime built via `apps/api/Dockerfile`. Only starts after `migration` completes successfully (`condition: service_completed_successfully`) and healthchecks pass.
- **`proxy`:** Nginx reverse proxy terminating TLS, adding security headers, and forwarding requests to `api:3000`. It is the only service publishing host ports (80 and 443); `api`, `postgres` and `redis` are reachable only over the internal bridge network.

### Environment Configuration

Create a secure `.env.production` file on the deployment host:

```bash
# Database Superuser / Migration credentials (DDL owner)
POSTGRES_USER=verixa
POSTGRES_PASSWORD=super-secret-postgres-password
POSTGRES_DB=verixa
DATABASE_MIGRATION_URL=postgresql://verixa:super-secret-postgres-password@postgres:5432/verixa

# Application Database credentials (Least-privilege role with RLS enforcement)
DATABASE_URL=postgresql://verixa_app:verixa_app@postgres:5432/verixa

# Redis Configuration
REDIS_PASSWORD=super-secret-redis-password
REDIS_URL=redis://:super-secret-redis-password@redis:6379

# Application Secrets
# At least 32 characters; generate with `openssl rand -base64 48`
SESSION_ACCESS_TOKEN_SECRET=replace-with-output-of-openssl-rand-base64-48
LOG_LEVEL=info

# Edge Ports
PORT_HTTP=80
PORT_HTTPS=443
```

> [!IMPORTANT]
> The API container must connect as `verixa_app`, not the PostgreSQL superuser. PostgreSQL superusers bypass Row Level Security (RLS) entirely, which would compromise tenant isolation policies.

### Launching the Stack

To build and start the entire stack:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
```

Monitor deployment logs:

```bash
# Verify migration completed successfully
docker compose -f docker-compose.prod.yml logs migration

# Follow API runtime logs
docker compose -f docker-compose.prod.yml logs -f api
```

### TLS at the edge

TLS is terminated by Nginx, not by the Fastify process. The application keeps
speaking plain HTTP on the internal network and receives `X-Forwarded-Proto:
https`, which it uses through `TRUST_PROXY=true` for cookies, redirects and
rate limits. This keeps certificates, cipher suites and renewal out of the
application image and out of every replica; transport security is one
operator concern at one boundary. We rejected enabling TLS inside Fastify
because it would duplicate configuration per replica, require private keys in
the application's runtime environment, and make local development differ from
production in the one place where mistakes are least forgiving.

Port 80 serves one exception to the redirect: `/.well-known/acme-challenge/`.
Let's Encrypt's HTTP-01 validation arrives over plain HTTP by definition. If
that path redirected too, a certificate could never be issued or renewed.
Every other HTTP request receives a `301` to the same path on HTTPS.

For a real certificate, point DNS at the host, then set `CERTBOT_DOMAIN` and
`CERTBOT_EMAIL` in the operator environment and run the profiled helper:

```bash
docker compose --env-file .env.production -f docker-compose.yml \
  -f docker-compose.prod.yml --profile certbot run --rm certbot
```

Certbot writes under `infra/nginx/certs/live/$CERTBOT_DOMAIN/`. Nginx reads the
two stable filenames it is configured with, so copy the issued files and
reload the proxy:

```bash
cp infra/nginx/certs/live/$CERTBOT_DOMAIN/fullchain.pem infra/nginx/certs/fullchain.pem
cp infra/nginx/certs/live/$CERTBOT_DOMAIN/privkey.pem infra/nginx/certs/privkey.pem
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec proxy nginx -s reload
```

Renewal reruns the same `certbot` command with `CERTBOT_DOMAIN` unset, which
invokes `certbot renew --webroot`; copy and reload again afterwards. Generated
PEM files are git-ignored — a private key in a commit is compromised even if
the repository is private.

CI does not use Let's Encrypt. `infra/ci/compose-tls-smoke.mjs` generates a
one-day self-signed certificate, starts `infra/docker/docker-compose.tls-smoke.yml`
(the production `nginx.conf` with a stub API), and asserts that plain HTTP
returns a redirect to HTTPS, that an HTTPS request completes a verified TLS
handshake, and that the response came from `api:3000`. That verifies the same
configuration that ships without depending on external ACME availability.

### Backup and restore

Postgres and Redis data live in **named volumes**
(`verixa-prod-postgres-data` and `verixa-prod-redis-data`). Named volumes are
the right default for stateful containers: Docker owns their lifecycle, they
survive `docker compose down && up` (without `-v`), and they are not tied to a
host directory whose permissions or filesystem layout must be managed by
hand. We rejected bind mounts for production because host paths make backups
depend on a particular machine's directory structure, and anonymous volumes
are discarded by the very command operators use to recreate containers. The
mental model is simple: the container is disposable, the volume is not.

`infra/docker/scripts/backup.mjs` runs the dump tools **inside** the running
containers, so the client versions match the servers and no database port is
published to the host. `pg_dump --format=custom` produces a compressed,
selectively restorable dump; `redis-cli --rdb -` asks Redis for a consistent
RDB snapshot even though AOF is the live persistence mode. Credentials are
forwarded from the operator's environment with `docker compose exec -e KEY`
rather than placed in the process arguments.

```bash
# From the repository root, with the production values in the environment:
export PGUSER=verixa PGPASSWORD='...' REDISCLI_AUTH='...'
node infra/docker/scripts/backup.mjs \
  --compose-file docker-compose.yml --compose-file docker-compose.prod.yml \
  --env-file .env.production --output-dir backups --label pre-upgrade
```

Restore is destructive and therefore needs an explicit acknowledgement:

```bash
VERIXA_RESTORE_CONFIRM=1 node infra/docker/scripts/restore.mjs \
  --compose-file docker-compose.yml --compose-file docker-compose.prod.yml \
  --env-file .env.production \
  --dump backups/postgres-pre-upgrade.dump \
  --rdb backups/redis-pre-upgrade.rdb
```

The restore stops Redis, deletes its AOF directory, copies the RDB into
`/data`, and starts it again. Deleting the AOF is not cosmetic: Redis prefers
an existing AOF over an RDB at startup, so leaving it in place would make the
restore appear to succeed while serving the old dataset. Postgres is restored
with `pg_restore --clean --if-exists --single-transaction`, which replaces the
previous objects atomically instead of merging a half-restored dump into them.

`scripts/db-backup.sh` and `scripts/db-restore.sh` remain development-only
tools against a local `DATABASE_URL`; do not use them for the production
compose stack.

The `compose-backup-restore` CI job performs a real drill: it seeds a Postgres
row and a Redis key, takes a backup, recreates the containers **without**
`-v` to prove the named volumes hold the data, then runs `down --volumes`,
starts from empty volumes, restores, and asserts both values came back. A
backup that has never been restored is not a backup.

---

## 2. Platform-as-a-Service (PaaS / Fly.io)

For teams leveraging managed platforms (e.g., Fly.io, Railway, Render), Verixa provides an optimized PaaS configuration manifest in `infra/docker/platform.toml`.

### Architecture

In a PaaS deployment:

- Managed PostgreSQL (e.g., Fly Postgres, Supabase, AWS RDS) is attached externally.
- Managed Redis (e.g., Upstash, Fly Redis, AWS ElastiCache) is attached externally.
- Compute is horizontally scalable with zero-downtime rolling deploys.
- Database migrations execute during the **release phase** before any traffic routes to the new containers.

### Release-Phase Migrations

`infra/docker/platform.toml` declares an automated release command:

```toml
[deploy]
  release_command = "pnpm --filter @verixa/database run db:migrate:deploy"
  strategy = "rolling"
```

When a new version is deployed:

1. The platform builds the production container using `apps/api/Dockerfile`.
2. An ephemeral machine boots and executes `release_command`.
3. If migrations succeed, the platform initiates a rolling update of the API machines.
4. If migrations fail, the deployment immediately aborts, keeping existing production machines intact.

### Setting Secrets

Configure production secrets via your platform CLI:

```bash
fly secrets set \
  DATABASE_URL="postgresql://verixa_app:password@your-postgres-host:5432/verixa" \
  DATABASE_MIGRATION_URL="postgresql://verixa:password@your-postgres-host:5432/verixa" \
  REDIS_URL="redis://:password@your-redis-host:6379" \
  SESSION_ACCESS_TOKEN_SECRET="$(openssl rand -base64 48)" \
  LOG_LEVEL="info"
```

### Deploying to Fly.io

Deploy using the reference configuration:

```bash
fly deploy --config infra/docker/platform.toml
```

### Health Checks & Rolling Restarts

The platform continuously monitors API instances via the `/health` endpoint:

```toml
[[http_service.checks]]
  interval = "10s"
  timeout = "2s"
  grace_period = "5s"
  method = "GET"
  path = "/health"
```

If a container fails health checks, traffic is diverted to healthy instances automatically.

---

## 3. Secrets Management Strategy (Issue 391)

Verixa adheres to strict zero-leak secrets management: **no production secrets ever live in a committed file, git repository, or container image layer.**

### Why Secrets Managers Beat Committed Encrypted Files

While tools like `git-crypt`, `sops`, or committed encrypted files allow version-controlling encrypted blobs, Verixa rejects committed secrets for production in favor of dynamic environment injection from dedicated secret managers (e.g. AWS Secrets Manager, HashiCorp Vault, Doppler).

The key architectural differences are:

1. **Instant Secret Rotation:** When a database password or signing key is rotated in a secret manager, applications can re-fetch or restart against the new secret immediately. With committed encrypted files, rotation requires an engineer to edit files, create a pull request, wait for CI builds, and deploy new code.
2. **Comprehensive Audit Logging:** Secret managers provide immutable audit trails recording every identity that read, updated, or rotated a secret. Committed files provide zero visibility into who decrypted a secret on their workstation.
3. **Strict Blast Radius & Least Privilege:** Developers and CI runners only receive temporary access tokens or build credentials. Production database passwords and signing keys are never exposed on development laptops or in CI logs.
4. **Permanent Commit History Protection:** A committed secret—even if accidentally pushed in an unencrypted commit or decrypted during a rebase—is permanently stored in git history. With secret managers, human error cannot leak credentials into git logs.

### The `SecretsSource` Port & Dev Adapter

To maintain clean architecture, `@verixa/config` defines an abstract `SecretsSource` port:

```typescript
export interface SecretsSource {
  readonly name: string;
  getSecret(key: string): Promise<string | undefined>;
  getSecrets(keys?: readonly string[]): Promise<Record<string, string>>;
  hasSecret(key: string): Promise<boolean>;
}
```

#### Local Development: `DotenvSecretsSource`

For local development, engineers copy `.env.example` to `.env`. The `DotenvSecretsSource` (aliased as `DevSecretsSource`) reads from this local, uncommitted file:

```typescript
import { DotenvSecretsSource } from "@verixa/config";

const secretsSource = new DotenvSecretsSource({
  filePath: ".env",
});

const sessionSecret = await secretsSource.getSecret("SESSION_ACCESS_TOKEN_SECRET");
```

If `.env` is absent, it falls back gracefully to `process.env`.

### Real-World Production Integration Patterns

#### Pattern A: AWS Secrets Manager (Task-Level Injection)

In AWS ECS / Fargate, secrets are injected directly into container environment variables at task launch time without embedding AWS SDK calls into application code:

```json
{
  "name": "api",
  "image": "ghcr.io/kyvera-labs/verixa:sha-0123456",
  "secrets": [
    {
      "name": "SESSION_ACCESS_TOKEN_SECRET",
      "valueFrom": "arn:aws:secretsmanager:us-east-1:123456789012:secret:verixa/prod/session-secret"
    },
    {
      "name": "DATABASE_URL",
      "valueFrom": "arn:aws:secretsmanager:us-east-1:123456789012:secret:verixa/prod/database-url"
    }
  ]
}
```

For applications fetching secrets dynamically at runtime, implement the `SecretsSource` port:

```typescript
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import type { SecretsSource } from "@verixa/config";

export class AwsSecretsManagerSource implements SecretsSource {
  public readonly name = "aws-secrets-manager";
  private readonly client = new SecretsManagerClient({});

  public async getSecret(key: string): Promise<string | undefined> {
    try {
      const response = await this.client.send(new GetSecretValueCommand({ SecretId: key }));
      return response.SecretString;
    } catch {
      return undefined;
    }
  }

  public async getSecrets(keys?: readonly string[]): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    if (!keys) return result;
    for (const key of keys) {
      const val = await this.getSecret(key);
      if (val !== undefined) result[key] = val;
    }
    return result;
  }

  public async hasSecret(key: string): Promise<boolean> {
    const val = await this.getSecret(key);
    return val !== undefined;
  }
}
```

#### Pattern B: HashiCorp Vault (Kubernetes Sidecar / Agent)

In Kubernetes, the Vault Agent Injector writes secrets to an in-memory `tmpfs` volume or injects environment variables:

```yaml
annotations:
  vault.hashicorp.com/agent-inject: "true"
  vault.hashicorp.com/role: "verixa-api"
  vault.hashicorp.com/agent-inject-secret-config: "secret/data/verixa/production"
  vault.hashicorp.com/agent-inject-template-config: |
    {{- with secret "secret/data/verixa/production" -}}
    SESSION_ACCESS_TOKEN_SECRET="{{ .Data.data.session_access_token_secret }}"
    DATABASE_URL="{{ .Data.data.database_url }}"
    {{- end -}}
```

#### Pattern C: Doppler CLI Injection

For Doppler users, the CLI injects secrets into the runtime environment:

```bash
doppler run -- docker compose -f docker-compose.prod.yml up -d
```

---

## 4. Migrations-on-Deploy: Dedicated Pre-Start Step (Issue 392)

Verixa separates schema migration from application startup: **migrations execute in a dedicated, pre-deploy one-shot step before any API replica boots.**

### Why `prisma migrate deploy` (Not `prisma migrate dev`)

- `prisma migrate dev` is strictly a development command: it generates new migration files, inspects local drift, prompts interactively to reset databases when drift occurs, and requires an auxiliary shadow database.
- `prisma migrate deploy` is the deterministic production command: it applies pending, committed migration files in lexical order without prompting or generating files.

### Avoiding the Multi-Replica Race Condition

In modern deployments, multiple API container replicas boot in parallel. If each API instance attempted to run `prisma migrate deploy` during application startup:

1. **Deadlocks and Contention:** Multiple instances concurrently query and attempt to acquire advisory or transactional locks on the `_prisma_migrations` tracking table.
2. **Schema Inconsistency:** Replicas that start faster may serve incoming traffic against an intermediate, half-migrated database schema while a slower replica is still executing DDL.
3. **Flapping Failures:** If migration fails mid-flight, all replicas crash-loop simultaneously, rendering the entire service unavailable.

Verixa solves this by ensuring migrations execute as a single-flight prerequisite:

```mermaid
sequenceDiagram
    autonumber
    actor Deployer as CI / Deploy Pipeline
    participant DB as PostgreSQL
    participant Migrator as One-Shot Migration Job
    participant API as API Replicas (N instances)

    Deployer->>DB: Check readiness
    Deployer->>Migrator: Run ./infra/docker/scripts/migrate.sh
    activate Migrator
    Migrator->>DB: Apply pending DDL migrations (Single-flight)
    DB-->>Migrator: Schema updated
    Migrator-->>Deployer: Exit code 0 (Success)
    deactivate Migrator

    Deployer->>API: Boot replicas (rolling deploy)
    activate API
    API->>DB: Connect with unprivileged verixa_app role
    API-->>Deployer: Health check passes (/health)
    deactivate API
```

### Automation in Tooling

1. **Production Compose:** `docker-compose.prod.yml` defines `migration` as a one-shot container with `restart: "no"`. The `api` container explicitly declares `depends_on: { migration: { condition: service_completed_successfully } }`.
2. **Deployment Script:** `infra/docker/scripts/migrate.sh` validates owner credentials and executes `db:migrate:deploy`.
3. **CI/CD Pipeline:** Deployment pipelines run a `pre-deploy-migrations` job executing `./infra/docker/scripts/migrate.sh` and assert that running the migration runner twice in a row is an idempotent no-op before triggering container rollout.

---

## 5. Forward-Only Migration Policy & Rollback Procedure (Issue 393)

Production databases in Verixa follow a **strictly forward-only migration policy**. Auto-generated down-migrations are prohibited in production.

### Why Roll Forward, Don't Roll Back

1. **Down-Migrations Silently Fail:** Down-migrations are rarely tested, frequently lossy (dropping columns destroys data irreversibly), and often out-of-date by the time an emergency occurs.
2. **Rolling Deploy Compatibility:** During a rolling deploy or canary release, old and new application versions run simultaneously. Reverting the database schema immediately crashes the new pods that are already serving traffic.
3. **Clean Auditability:** Forward-only migrations preserve a complete, linear history of database evolution in `_prisma_migrations`.

### Correcting a Defective Migration (Fix-Forward Runbook)

When a deployed migration causes an unexpected issue:

1. **Do Not Roll Back the Schema:** Never execute manual `DROP` statements or reverse Prisma migrations on live databases.
2. **Assess Application Compatibility:** If the application image cannot operate with the current schema, check whether rolling back the application container image alone resolves the issue (see [Zero-Downtime Migration Compatibility Checklist](#6-zero-downtime-migration-compatibility-checklist-issue-394)).
3. **Generate a Fix-Forward Migration:**
   Create a new migration using the template at `packages/database/prisma/templates/fix-forward.sql`:
   ```bash
   pnpm --filter @verixa/database exec prisma migrate dev --create-only --name fix_forward_<incident_description>
   ```
4. **Compensate Safely:** Write compensating DDL (e.g. relaxing an overly strict constraint, creating a missing index, or adding a corrected column).
5. **Document Data Preservation:** If any data must be moved or cleaned up, include a `-- DATA PRESERVATION:` comment block explaining the backup and preservation verification steps.
6. **Deploy the Fix:** Deploy the fix forward through the standard pre-deploy pipeline.

### Enforcing Data Preservation in CI

Verixa's CI check (`infra/ci/check-migration-safety.ts`) scans every migration file:

- Destructive operations (`DROP TABLE`, `DROP COLUMN`, `DROP SCHEMA`, `TRUNCATE`) are blocked unless accompanied by a documented data-preservation note (`-- DATA PRESERVATION: <details>`).

---

## 6. Zero-Downtime Migration Compatibility Checklist (Issue 394)

To support zero-downtime rolling deployments, schema changes must obey the **expand/contract pattern**: **"old code, new schema" must always be a valid, operational combination.**

### The Expand/Contract Lifecycle

```mermaid
flowchart LR
    subgraph Deploy1["Deploy 1: Expand"]
        M1["Add nullable column or table"]
        C1["Deploy code reading old, writing both"]
    end
    subgraph Deploy2["Deploy 2: Backfill"]
        B["Backfill historical data in batches"]
    end
    subgraph Deploy3["Deploy 3: Contract"]
        C2["Deploy code reading new only"]
        M2["Enforce NOT NULL constraint or drop old"]
    end

    Deploy1 --> Deploy2 --> Deploy3
```

### Compatibility Checklist & Examples

#### Case 1: Adding a Mandatory Column

❌ **Unsafe Single-Step Migration (Blocked by CI advisory check):**

```sql
-- Fails zero-downtime check: existing rows have no value, and old replicas insert NULL
ALTER TABLE "users" ADD COLUMN "organization_role" TEXT NOT NULL;
```

✅ **Safe Expand/Contract Strategy:**

- **Step 1 (Expand - Release N):** Add the column as nullable (or with a safe constant DEFAULT):
  ```sql
  ALTER TABLE "users" ADD COLUMN "organization_role" TEXT;
  ```
- **Step 2 (Deploy - Release N):** Deploy code that writes `organization_role` on new user creation and provides a fallback when reading NULL.
- **Step 3 (Backfill):** Backfill existing rows:
  ```sql
  UPDATE "users" SET "organization_role" = 'member' WHERE "organization_role" IS NULL;
  ```
- **Step 4 (Contract - Release N+1):** Enforce the `NOT NULL` constraint in the subsequent release once all rows are guaranteed populated:
  ```sql
  ALTER TABLE "users" ALTER COLUMN "organization_role" SET NOT NULL;
  ```

#### Case 2: Renaming a Column

❌ **Unsafe Single-Step Migration:**

```sql
ALTER TABLE "users" RENAME COLUMN "given_name" TO "first_name";
```

✅ **Safe Expand/Contract Strategy:**

- **Step 1 (Expand):** Add `first_name` as a nullable column.
- **Step 2 (Deploy):** Update application code to write to both `given_name` and `first_name` (dual-write), but read from `given_name`.
- **Step 3 (Backfill):** `UPDATE "users" SET "first_name" = "given_name" WHERE "first_name" IS NULL;`
- **Step 4 (Switch):** Deploy application version reading from `first_name`.
- **Step 5 (Contract):** Drop `given_name` with `-- DATA PRESERVATION:` note.

#### Case 3: Dropping a Column or Table

- **Step 1 (Deprecate):** Remove all application reads and writes to the column/table. Deploy and verify in production.
- **Step 2 (Contract):** In a subsequent release, drop the column/table with the required preservation note:
  ```sql
  -- DATA PRESERVATION: Column "deprecated_field" verified unused for 30 days and archived in cold storage.
  ALTER TABLE "users" DROP COLUMN "deprecated_field";
  ```

### Automated Safety Check

Run the migration safety checker locally before pushing:

```bash
pnpm run check:migration-safety
```

---

## 7. Container image tags

The API image is published to `ghcr.io/kyvera-labs/verixa` for merges to `main` and semantic version tags (`vX.Y.Z`). Each build has a `sha-<short-sha>` reference, which is the deployment and rollback identifier: it points to the exact source commit and is never intentionally overwritten. `latest` follows `main` and release tags; a release also receives its `vX.Y.Z` tag.

Use the commit tag in automated deployments. `latest` is convenient for discovery, but moves as new code is published, so a deployment recorded only as `latest` cannot be reproduced or rolled back reliably. Images are built for `linux/amd64` and `linux/arm64` from the same source commit.

---

## 8. Rolling back an application image

Before rolling back, select the last known-good `sha-<short-sha>` tag and confirm the currently deployed schema remains compatible with that image.

Rollback does not run migrations in reverse. A migration that drops or renames a column, changes data representation, or tightens a constraint can make an older application unable to use the new schema. Follow the expand-and-contract checklist before deploying migrations; if backward compatibility is not established, restore the database from a verified backup or deploy a forward fix instead of restarting old code against an incompatible schema.

For a single Docker host, set the database URL and session secret in the operator's environment, then run:

```bash
SESSION_ACCESS_TOKEN_SECRET='...' \
DATABASE_URL='postgres://verixa_app:...@database:5432/verixa' \
REDIS_URL='redis://redis:6379' \
API_IMAGE='ghcr.io/kyvera-labs/verixa' \
./infra/docker/scripts/rollback.sh sha-0123456
```

The script pulls the requested image, replaces the API container, and waits for `/health`. It reports `/version` so the operator can confirm which build is serving. It does not alter database state. Adapt the container replacement step to the deployment platform when running Kubernetes or another scheduler; the invariant is to point the API deployment at the selected immutable tag, then verify health and version before declaring the rollback complete.

CI exercises this procedure with version A and B images: it starts B, selects A with the same rollback script, and asserts that both the health response and version response match A.

---

## 9. Staging and production deployment workflow

Verixa connects its release pipeline (`.github/workflows/release.yml`) and immutable container images (`.github/workflows/docker-publish.yml`) to staging and production via `.github/workflows/deploy.yml`.

### Progressive delivery: why staging-then-production with a human gate

Fully automated continuous deployment directly to production maximizes velocity, but it also maximizes blast radius: an unreviewed migration interaction, a misconfigured secret, or a subtle runtime regression reaches all users immediately. Conversely, fully manual deployments slow down feedback loops and encourage batching large, risky releases.

Verixa uses **progressive delivery** to balance both:

1. **Automatic staging deployment:** Every successful `Release` workflow run automatically deploys the newly published immutable image tag (`vX.Y.Z` or `sha-<short>`) to the `staging` GitHub Environment and verifies it with a post-deploy smoke test.
2. **Gated production promotion:** The `deploy-production` job depends on `deploy-staging` (`needs: [resolve-release, deploy-staging]`) and targets the `production` GitHub Environment. GitHub Environment protection rules (specified in `.github/environments/production.yml`) pause the workflow until a designated reviewer explicitly approves promotion.
3. **Fail-closed promotion and automatic rollback:** If staging deployment or its smoke test fails, staging automatically rolls back to its last known-good tag and the job fails — blocking production promotion completely. Production runs the same smoke test and automatic rollback on failure, so neither environment is ever left in an unknown state.

### Post-deploy smoke testing

Both staging and production run `infra/ci/deploy-smoke-test.mjs` before marking a deployment successful:

- Polls `GET /health` until HTTP `200` is returned within the retry budget.
- Verifies `GET /version` returns HTTP `200` and includes the expected immutable image tag.

Checking `/version` alongside `/health` is deliberate: if an orchestrator fails to replace the running container, the previous healthy container may continue serving `200 OK` on `/health`. A `/health`-only check would falsely report the deployment as successful; asserting `/version` catches that failure mode immediately.

### Key design decisions and rejected alternatives

- **`workflow_run` trigger vs. deploying inside `release.yml`:** We rejected adding deployment jobs directly to `release.yml`. `release.yml` requires `contents: write` to attach SBOMs and manage releases, while `deploy.yml` requires `deployments: write` and environment-scoped deployment secrets. Splitting them enforces least privilege and allows operators to re-deploy or roll back via `workflow_dispatch` without re-running release creation.
- **Human approval gate vs. fixed `wait_timer`:** `.github/environments/production.yml` sets `wait_timer: 0` and requires explicit reviewer approval (`prevent_self_review: true`). A fixed timer delays urgent security patches without verifying anything; a human gate lets maintainers verify staging telemetry and approve immediately when ready.
- **Immutable tags vs. `latest`:** `resolve-release` explicitly refuses to deploy `latest` and verifies the immutable tag exists in GHCR before touching staging. This guarantees staging and production run the exact same image digest and makes automatic rollback deterministic.
- **`cancel-in-progress: false`:** Concurrency groups for both `deploy-staging` and `deploy-production` never cancel an in-flight deployment, preventing half-applied rollouts or interrupted rollbacks.
