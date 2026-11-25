#!/usr/bin/env bash
# Runs the README quickstart end to end and fails unless one real auth flow
# succeeds (Issue 421). CI runs it in the `quickstart` job of ci.yml; run it
# locally from a clone with Docker available:
#
#   bash scripts/quickstart-smoke.sh
#
# This script is the source of truth for the quickstart, and README.md shows
# the same commands for people to read. To keep the two from drifting, the
# first step checks that every command run below still appears in README.md,
# so editing one without the other fails here, not in a newcomer's terminal.
#
# Rejected alternative: extract the README's code block and execute it. That
# guarantees no drift, but it forces the block people read to be a
# machine-runnable script: background processes, readiness polling, cleanup
# and unique test data. A README that reads like this file defeats its purpose.
#
# Postgres is left running afterwards, as `docker compose up -d` leaves it for
# a person following the README. The API process is always stopped.

set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${PORT:-3000}"
BASE_URL="http://localhost:${PORT}"
DEV_LOG="$(mktemp)"
DEV_PID=""

fail() {
  echo "quickstart-smoke: FAIL: $*" >&2
  if [[ -s "$DEV_LOG" ]]; then
    echo "--- last 40 lines of the API log ---" >&2
    tail -n 40 "$DEV_LOG" >&2
  fi
  exit 1
}

cleanup() {
  if [[ -n "$DEV_PID" ]]; then
    # `pnpm dev` runs a build and then `tsx watch`, which forks; stop the whole
    # process group when setsid gave us one, the process alone otherwise.
    kill -- "-$DEV_PID" 2>/dev/null || kill "$DEV_PID" 2>/dev/null || true
  fi
  rm -f "$DEV_LOG"
}
trap cleanup EXIT

step() {
  echo
  echo "==> $*"
}

# 1. The README still documents exactly these steps.
step "Checking README.md documents every quickstart command"
for documented in \
  "pnpm install" \
  "docker compose up -d postgres" \
  "pnpm db:wait" \
  "export DATABASE_URL=postgres://verixa:verixa@localhost:5432/verixa" \
  "pnpm db:migrate:deploy" \
  'export SESSION_ACCESS_TOKEN_SECRET="$(openssl rand -base64 48)"' \
  "pnpm dev" \
  "http://localhost:3000/auth/register" \
  "http://localhost:3000/auth/login"; do
  grep -qF -- "$documented" README.md || fail "README.md no longer contains: $documented"
done

# 2. The quickstart itself, in README order.
step "pnpm install"
pnpm install

step "docker compose up -d postgres"
docker compose up -d postgres

step "pnpm db:wait"
pnpm db:wait

step "pnpm db:migrate:deploy"
export DATABASE_URL=postgres://verixa:verixa@localhost:5432/verixa
pnpm db:migrate:deploy

step "pnpm dev (in the background, logging to $DEV_LOG)"
export SESSION_ACCESS_TOKEN_SECRET="$(openssl rand -base64 48)"
if command -v setsid >/dev/null 2>&1; then
  PORT="$PORT" setsid pnpm dev >"$DEV_LOG" 2>&1 &
else
  PORT="$PORT" pnpm dev >"$DEV_LOG" 2>&1 &
fi
DEV_PID=$!

# `pnpm dev` builds the API's workspace dependencies before starting, so allow
# for a cold build, not just process startup.
for _ in $(seq 1 180); do
  if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
    break
  fi
  kill -0 "$DEV_PID" 2>/dev/null || fail "pnpm dev exited before the API answered /health"
  sleep 1
done
curl -fsS "$BASE_URL/health" >/dev/null 2>&1 || fail "the API did not answer /health within 180s"

# 3. One real auth flow. A unique email keeps the script re-runnable against
# a database that still holds the previous run's user.
EMAIL="quickstart-$(date +%s)-$$@example.com"
PASSWORD="correct horse battery staple"

expect_status() {
  local expected="$1" path="$2" body="$3" status
  status="$(curl -sS -o /dev/stderr -w '%{http_code}' -X POST "$BASE_URL$path" \
    -H 'content-type: application/json' -d "$body")"
  echo
  [[ "$status" == "$expected" ]] || fail "POST $path returned HTTP $status, expected $expected"
  echo "POST $path -> $status"
}

step "Register, then log in"
expect_status 201 /auth/register \
  "{\"email\":\"$EMAIL\",\"displayName\":\"Ada\",\"password\":\"$PASSWORD\"}"
expect_status 200 /auth/login "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}"

echo
echo "quickstart-smoke: OK"
