#!/bin/bash
# Chart tests for the storage engine (runbooks/postgres.md). Renders the chart and asserts:
#   - the default (SQLite) render has no DATABASE_URL and keeps the Litestream sidecar when enabled
#   - database.url renders a database Secret, DATABASE_URL and DATABASE_QUERY_URL from it,
#     and no Litestream sidecar, ConfigMap or Secret even with litestream.enabled=true
#   - database.existingSecret reads that Secret and renders no chart Secret
#   - api.replicas=2 fails on both engines
# Usage: bash scripts/check-chart-postgres.sh [chart dir]
set -euo pipefail

CHART="${1:-charts/agent-swarm}"
FAILURES=0

fail() {
  echo "FAIL: $1"
  FAILURES=$((FAILURES + 1))
}

render() {
  helm template release "$CHART" --set auth.apiKey=ci-render "$@"
}

LITESTREAM=(
  --set litestream.enabled=true
  --set litestream.bucket=ci-backup
  --set litestream.s3.accessKeyId=ci
  --set litestream.s3.secretAccessKey=ci
)

sqlite=$(render "${LITESTREAM[@]}")
grep -q "name: DATABASE_URL" <<<"$sqlite" && fail "SQLite render sets DATABASE_URL"
grep -q "name: litestream$" <<<"$sqlite" || fail "SQLite render with litestream.enabled has no sidecar"

postgres=$(render "${LITESTREAM[@]}" \
  --set database.url=postgres://swarm:pw@db:5432/swarm \
  --set database.queryUrl=postgres://swarm_reader@db:5432/swarm)
grep -q "name: release-agent-swarm-database" <<<"$postgres" || fail "Postgres render has no database Secret"
grep -q 'DATABASE_URL: "postgres://swarm:pw@db:5432/swarm"' <<<"$postgres" || fail "database Secret lacks DATABASE_URL"
grep -q 'DATABASE_QUERY_URL: "postgres://swarm_reader@db:5432/swarm"' <<<"$postgres" || fail "database Secret lacks DATABASE_QUERY_URL"
grep -q "name: DATABASE_URL" <<<"$postgres" || fail "Postgres render does not set DATABASE_URL on the API"
grep -q "name: DATABASE_QUERY_URL" <<<"$postgres" || fail "Postgres render does not set DATABASE_QUERY_URL on the API"
grep -q "name: litestream$" <<<"$postgres" && fail "Postgres render keeps the Litestream sidecar"
grep -q "litestream.yml" <<<"$postgres" && fail "Postgres render keeps the Litestream ConfigMap"
grep -q "release-agent-swarm-litestream-s3" <<<"$postgres" && fail "Postgres render keeps the Litestream Secret"

existing=$(render --set database.existingSecret=my-db)
grep -q "name: my-db" <<<"$existing" || fail "existingSecret render does not read my-db"
grep -q "release-agent-swarm-database" <<<"$existing" && fail "existingSecret render still renders the chart Secret"

if render --set api.replicas=2 >/dev/null 2>&1; then fail "api.replicas=2 renders on SQLite"; fi
if render --set api.replicas=2 --set database.url=postgres://db/swarm >/dev/null 2>&1; then
  fail "api.replicas=2 renders on Postgres"
fi

if [ "$FAILURES" -gt 0 ]; then
  echo "check-chart-postgres: $FAILURES failure(s)"
  exit 1
fi
echo "check-chart-postgres: all chart assertions passed"
