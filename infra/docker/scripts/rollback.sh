#!/usr/bin/env sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <previous-image-tag>" >&2
  exit 2
fi

image="${API_IMAGE:-ghcr.io/kyvera-labs/verixa}"
container="${API_CONTAINER_NAME:-verixa-api}"
port="${API_PORT:-3000}"
tag="$1"
pull="${API_PULL_IMAGE:-1}"

case "$tag" in
  *[!a-zA-Z0-9_.-]*|"") echo "invalid image tag: $tag" >&2; exit 2 ;;
esac
if [ -z "${SESSION_ACCESS_TOKEN_SECRET:-}" ]; then
  echo "SESSION_ACCESS_TOKEN_SECRET must be set before redeploying" >&2
  exit 2
fi
if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL must be set before redeploying" >&2
  exit 2
fi

target="$image:$tag"
if [ "$pull" = "1" ]; then
  docker pull "$target"
fi

# Replacing the container is intentional: the image tag is the release unit.
# Migrations are never run here; operators must first confirm the new schema is
# backward-compatible with the selected application image.
docker rm -f "$container" >/dev/null 2>&1 || true
docker run -d --name "$container" \
  --restart unless-stopped \
  --publish "${API_BIND_ADDRESS:-127.0.0.1}:$port:3000" \
  --env "DATABASE_URL=$DATABASE_URL" \
  --env "REDIS_URL=${REDIS_URL:-redis://127.0.0.1:6379}" \
  --env "SESSION_ACCESS_TOKEN_SECRET=$SESSION_ACCESS_TOKEN_SECRET" \
  "$target" >/dev/null

attempt=0
while [ "$attempt" -lt 30 ]; do
  if curl --fail --silent "http://${API_BIND_ADDRESS:-127.0.0.1}:$port/health" >/dev/null; then
    actual="$(curl --fail --silent "http://${API_BIND_ADDRESS:-127.0.0.1}:$port/version")"
    printf 'Rolled back to %s; version endpoint: %s\n' "$target" "$actual"
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 1
done

echo "rollback target $target did not become healthy" >&2
docker logs "$container" >&2 || true
exit 1
