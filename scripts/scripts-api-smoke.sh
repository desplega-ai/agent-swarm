#!/usr/bin/env bash
set -euo pipefail

API_KEY="${AGENT_SWARM_API_KEY:-${API_KEY:-123123}}"
BASE_URL="${SWARM_BASE_URL:-http://127.0.0.1:${PORT:-3013}}"
AGENT_ID="${SCRIPT_SMOKE_AGENT_ID:-scripts-smoke-agent}"
STARTED_SERVER=0
LOG_FILE="${TMPDIR:-/tmp}/scripts-api-smoke.log"

cleanup() {
  if [[ "$STARTED_SERVER" == "1" && -n "${SERVER_PID:-}" ]]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [[ -z "${SWARM_BASE_URL:-}" ]]; then
  AGENT_SWARM_API_KEY="$API_KEY" PORT="${PORT:-3013}" bun run start:http >"$LOG_FILE" 2>&1 &
  SERVER_PID=$!
  STARTED_SERVER=1
fi

for _ in {1..80}; do
  if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done
curl -fsS "$BASE_URL/health" >/dev/null

curl -fsS -X POST "$BASE_URL/api/agents" \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Agent-ID: $AGENT_ID" \
  -H "Content-Type: application/json" \
  -d '{"name":"Scripts Smoke Agent","isLead":false}' >/dev/null

UPSERT_BODY="$(mktemp)"
RUN_BODY="$(mktemp)"
SEARCH_BODY="$(mktemp)"
trap 'rm -f "$UPSERT_BODY" "$RUN_BODY" "$SEARCH_BODY"; cleanup' EXIT

cat >"$UPSERT_BODY" <<'JSON'
{
  "name": "scripts-smoke-double",
  "description": "Smoke test double helper",
  "intent": "scripts api smoke",
  "source": "export default async (args: { value: number }): Promise<{ result: number }> => ({ result: args.value * 2 });"
}
JSON

cat >"$RUN_BODY" <<'JSON'
{
  "name": "scripts-smoke-double",
  "args": { "value": 21 },
  "intent": "scripts api smoke"
}
JSON

cat >"$SEARCH_BODY" <<'JSON'
{
  "query": "smoke-double",
  "limit": 5
}
JSON

curl -fsS -X POST "$BASE_URL/api/scripts/upsert" \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Agent-ID: $AGENT_ID" \
  -H "Content-Type: application/json" \
  -d @"$UPSERT_BODY" | grep -q '"version":1'

curl -fsS -X POST "$BASE_URL/api/scripts/search" \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Agent-ID: $AGENT_ID" \
  -H "Content-Type: application/json" \
  -d @"$SEARCH_BODY" | grep -q 'scripts-smoke-double'

curl -fsS -X POST "$BASE_URL/api/scripts/run" \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Agent-ID: $AGENT_ID" \
  -H "Content-Type: application/json" \
  -d @"$RUN_BODY" | grep -q '"result":42'

curl -fsS -X DELETE "$BASE_URL/api/scripts/scripts-smoke-double?scope=agent" \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Agent-ID: $AGENT_ID" | grep -q '"deleted":true'

echo "scripts API smoke passed"
