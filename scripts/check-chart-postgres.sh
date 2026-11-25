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

# Runner packaging is opt-in and requires PostgreSQL and its own credentials.
RUNNER=(--set scriptRunner.enabled=true --set scriptRunner.token=runner-ci)
DB=(--set database.url=postgres://swarm:pw@db:5432/swarm)
runner=$(render "${DB[@]}" "${RUNNER[@]}" --show-only templates/script-runner-deployment.yaml)
grep -q -e '-auth' -e 'API_KEY' -e 'DATABASE_URL' -e 'envFrom:' <<<"$runner" && fail "runner receives API credentials"
grep -q 'runAsUser: 0' <<<"$runner" || fail "runner cannot drop native child uid"
grep -q '/run/agent-swarm-script-runner/ready' <<<"$runner" || fail "runner lacks file readiness probe"
grep -q 'SCRIPT_RUNNER_TOKEN_FILE' <<<"$runner" || fail "runner lacks token file"
grep -q 'defaultMode: 256' <<<"$runner" || grep -q 'defaultMode: 0400' <<<"$runner" || fail "runner token is not root-only"
config=$(render "${DB[@]}" "${RUNNER[@]}" --show-only templates/configmap.yaml)
grep -q 'SCRIPT_EMBEDDED_RUNNER_SLOTS: "0"' <<<"$config" || fail "runner does not disable embedded slots"
override=$(render "${DB[@]}" "${RUNNER[@]}" --set config.extraEnv.SCRIPT_EMBEDDED_RUNNER_SLOTS=2 --show-only templates/configmap.yaml)
grep -q 'SCRIPT_EMBEDDED_RUNNER_SLOTS: "2"' <<<"$override" || fail "embedded slots override lost"
[ "$(grep -c 'SCRIPT_EMBEDDED_RUNNER_SLOTS:' <<<"$override")" -eq 1 ] || fail "duplicate embedded slots key"
grep -q 'script-runner' <<<"$sqlite" && fail "default render includes script runners"
if render "${RUNNER[@]}" >/dev/null 2>&1; then fail "runner renders without PostgreSQL"; fi
if render "${DB[@]}" --set scriptRunner.enabled=true >/dev/null 2>&1; then fail "runner renders without token"; fi
for field in replicas slots terminationGracePeriodSeconds; do
  for invalid in 0 -1 1.5; do
    if render "${DB[@]}" "${RUNNER[@]}" --set "scriptRunner.$field=$invalid" >/dev/null 2>&1; then
      fail "runner accepts $field=$invalid"
    fi
  done
done
existingRunner=$(render --set database.existingSecret=my-db --set scriptRunner.enabled=true --set scriptRunner.existingSecret=my-runner)
grep -q 'secretName: my-runner' <<<"$existingRunner" || fail "existing runner Secret ignored"
grep -q 'SCRIPT_RUNNER_TOKEN: ' <<<"$existingRunner" && fail "existing runner Secret still creates a token"
if render "${DB[@]}" "${RUNNER[@]}" --set scriptRunner.existingSecret=release-agent-swarm-auth >/dev/null 2>&1; then
  fail "runner accepts API auth Secret"
fi
https=$(render "${DB[@]}" "${RUNNER[@]}" --set scriptRunner.apiUrl=https://api.example.test/ --show-only templates/script-runner-deployment.yaml)
grep -q 'value: "https://api.example.test"' <<<"$https" || fail "HTTPS override ignored"
if render "${DB[@]}" "${RUNNER[@]}" --set scriptRunner.apiUrl=https://api.example.test/path >/dev/null 2>&1; then
  fail "runner accepts an API URL with a path"
fi
KEDA=(--set scriptRunner.keda.enabled=true --set scriptRunner.keda.existingSecret=metrics-user)
keda=$(render "${DB[@]}" "${RUNNER[@]}" "${KEDA[@]}" --show-only templates/script-runner-scaledobject.yaml)
for expected in 'kind: ScaledObject' 'kind: TriggerAuthentication' 'minReplicaCount: 1' 'maxReplicaCount: 10' 'valueLocation: lanes.sync.queued' 'authMode: bearer' 'name: metrics-user' 'http://release-agent-swarm-api.default.svc:3013/api/script-runners'; do
  grep -q "$expected" <<<"$keda" || fail "KEDA missing $expected"
done
for field in minReplicaCount maxReplicaCount targetValue pollingInterval cooldownPeriod; do
  if render "${DB[@]}" "${RUNNER[@]}" "${KEDA[@]}" --set "scriptRunner.keda.$field=0" >/dev/null 2>&1; then
    fail "KEDA accepts $field=0"
  fi
done
if render "${DB[@]}" "${RUNNER[@]}" "${KEDA[@]}" --set scriptRunner.keda.minReplicaCount=11 >/dev/null 2>&1; then
  fail "KEDA accepts max below min"
fi
for invalid in release-agent-swarm-auth release-agent-swarm-script-runner ''; do
  if render "${DB[@]}" "${RUNNER[@]}" "${KEDA[@]}" --set "scriptRunner.keda.existingSecret=$invalid" >/dev/null 2>&1; then
    fail "KEDA accepts missing or shared credentials"
  fi
done

if [ "$FAILURES" -gt 0 ]; then
  echo "check-chart-postgres: $FAILURES failure(s)"
  exit 1
fi
echo "check-chart-postgres: all chart assertions passed"
