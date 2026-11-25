#!/usr/bin/env sh
set -eu

# infra/docker/scripts/migrate.sh
# Migrations-on-deploy runner (Issue 392 / #504)
#
# Runs `prisma migrate deploy` against the target database before any API replica starts.
#
# Why this script exists:
# 1. Deterministic schema execution: `prisma migrate deploy` executes existing, committed migrations
#    without generating new migrations or prompting interactively (unlike `prisma migrate dev`).
# 2. Race condition prevention: running migrations as an isolated, single-flight pre-deploy step
#    prevents the "N replicas all racing to migrate the schema" failure mode during rolling boots.
# 3. Security boundary: migrations require DDL permissions (Postgres table alter/create, DDL owner)
#    via DATABASE_MIGRATION_URL. The runtime API connects with unprivileged verixa_app credentials.
# 4. Idempotency: running this script multiple times in succession against the same database is a safe no-op.
# 5. Failure blocking: any migration failure immediately returns a non-zero exit code to block deployment.

MIGRATION_URL="${DATABASE_MIGRATION_URL:-${DATABASE_URL:-}}"
if [ -z "$MIGRATION_URL" ]; then
  echo "Error: DATABASE_MIGRATION_URL or DATABASE_URL must be set before migrating" >&2
  exit 2
fi

export DATABASE_URL="$MIGRATION_URL"

echo "Applying pending database schema migrations with prisma migrate deploy..."

# If pnpm is available (monorepo root or build container), use the workspace filter
if command -v pnpm >/dev/null 2>&1; then
  pnpm --filter @verixa/database run db:migrate:deploy
elif command -v npx >/dev/null 2>&1; then
  # Prisma 7 reads the schema path and DATABASE_URL from prisma.config.ts,
  # which it only finds in the working directory unless pointed at it.
  CONFIG_PATH="${PRISMA_CONFIG_PATH:-packages/database/prisma.config.ts}"
  npx prisma migrate deploy --config="$CONFIG_PATH"
else
  echo "Error: Neither pnpm nor npx is available to execute prisma migrate deploy" >&2
  exit 1
fi

echo "Database migrations applied successfully."
