#!/usr/bin/env bash
# End-to-end test of the self-driving MVP extension with mocked Sentry payloads.
# Installs from the catalog, enables, sends 4 curls to the workflow webhook,
# prints each run's result, then disables and uninstalls and checks every asset is gone.
#
# Usage: MCP_BASE_URL=http://localhost:3013 API_KEY=123123 bash demo.sh
# Needs: curl, jq, and a swarm whose catalog includes self-driving.
set -euo pipefail

BASE="${MCP_BASE_URL:-http://localhost:3013}"
KEY="${AGENT_SWARM_API_KEY:-${API_KEY:-123123}}"
AUTH=(-H "Authorization: Bearer $KEY" -H "Content-Type: application/json")
CONFIG='{"classifier":"rules","threshold":3,"repos":[{"project":"demo-shop-web","repo":"desplega-ai/sds-demo-shop"}],"dispatch":false}'
FP="cart-undefined-$(date +%s)"

step() { printf '\n### %s\n' "$*"; }

step "install from catalog"
INSTALL=$(curl -sf -X POST "$BASE/api/extensions/install" "${AUTH[@]}" \
  -d "{\"template\":\"self-driving\",\"config\":$CONFIG}")
jq -c '{id: .extension.id, enabled: .extension.enabled, created: [.assets.created[] | "\(.kind):\(.name)"]}' <<<"$INSTALL"
EXT_ID=$(jq -r .extension.id <<<"$INSTALL")
step "enable"
curl -sf -X POST "$BASE/api/extensions/$EXT_ID/enable" "${AUTH[@]}" | jq -c '{enabled: .extension.enabled, status: .extension.status}'

WF_ID=$(curl -sf "$BASE/api/workflows" "${AUTH[@]}" |
  jq -r '.[] | select(.name == "self-driving-signal") | .id')
WF=$(curl -sf "$BASE/api/workflows/$WF_ID" "${AUTH[@]}")
EXT_AGENT=$(jq -r .createdByAgentId <<<"$WF")
echo "workflow self-driving-signal = $WF_ID (enabled: $(jq .enabled <<<"$WF"), runs as ext agent $EXT_AGENT)"
TASKS_BEFORE=$(curl -sf "$BASE/api/tasks?limit=1000" "${AUTH[@]}" | jq '.tasks | length')

# POST a body to the webhook, wait for the run, print the step results.
send() {
  local body="$1" resp code run status
  echo "\$ curl -X POST $BASE/api/webhooks/$WF_ID -d '$body'"
  resp=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/webhooks/$WF_ID" -H 'Content-Type: application/json' -d "$body")
  code=$(tail -n1 <<<"$resp")
  echo "HTTP $code $(head -n -1 <<<"$resp")"
  [[ "$code" == "201" ]] || return 0
  run=$(head -n -1 <<<"$resp" | jq -r .runId)
  for _ in $(seq 1 60); do
    status=$(curl -sf "$BASE/api/workflow-runs/$run" "${AUTH[@]}" | jq -r '.run.status // .status')
    [[ "$status" == "running" || "$status" == "pending" ]] || break
    sleep 1
  done
  curl -sf "$BASE/api/workflow-runs/$run" "${AUTH[@]}" | jq -c '{status: (.run.status // .status),
    steps: [(.steps // [])[] | {node: .nodeId, status, result: .output.result}]
      | map(select(.node == "classify" or .node == "cluster" or .node == "propose"))
      | map({(.node): (if .node == "classify" then .result.classification | {kind, route, severity}
                       elif .node == "cluster" then (.result | {dropped, isNew, overThreshold, count: .cluster.count, id: .cluster.id})
                       else .result.action end)}) | add}'
}

error_body() {
  echo "{\"project\":\"demo-shop-web\",\"event\":{\"event_id\":\"$1\",\"title\":\"TypeError: cart is undefined\",\"level\":\"error\",\"culprit\":\"checkout/submit\",\"fingerprint\":[\"$FP\"]}}"
}

step "1. new error -> new cluster"
send "$(error_body e1)"

step "2. same fingerprint past threshold (3) -> proposed action"
send "$(error_body e2)" >/dev/null
send "$(error_body e3)"

step "3. noise -> classified noise and dropped"
send '{"project":"demo-shop-web","event":{"event_id":"n1","title":"ResizeObserver loop limit exceeded","level":"warning"}}'

step "4. malformed -> validation error"
send '{"project":"demo-shop-web","event":{"title":"missing level"}}'

step "sweep (schedule script, run by hand)"
curl -sf -X POST "$BASE/api/scripts/run" "${AUTH[@]}" -H "X-Agent-ID: $EXT_AGENT" \
  -d '{"name":"self-driving-cluster","scope":"global","args":{"mode":"sweep"}}' |
  jq -c '.result // .data.result // . | {clusters, threshold, pending: (.pending | length)}' || true

echo "tasks created by the loop: $(( $(curl -sf "$BASE/api/tasks?limit=1000" "${AUTH[@]}" | jq '.tasks | length') - TASKS_BEFORE ))"

step "disable + uninstall"
curl -sf -X POST "$BASE/api/extensions/$EXT_ID/disable" "${AUTH[@]}" >/dev/null
curl -sf -X DELETE "$BASE/api/extensions/$EXT_ID" "${AUTH[@]}" | jq -c .

step "leftover assets (all should be 0)"
echo "scripts:   $(curl -sf "$BASE/api/scripts?scope=global" "${AUTH[@]}" | jq '[(.scripts // .data.scripts // [])[] | select(.name | startswith("self-driving-"))] | length')"
echo "schedules: $(curl -sf "$BASE/api/schedules" "${AUTH[@]}" | jq '[.schedules[] | select(.name | startswith("self-driving-"))] | length')"
echo "workflows: $(curl -sf "$BASE/api/workflows" "${AUTH[@]}" | jq '[.[] | select(.name | startswith("self-driving-"))] | length')"
echo "skills:    $(curl -sf "$BASE/api/skills" "${AUTH[@]}" | jq '[.skills[] | select(.name | startswith("self-driving-"))] | length')"
echo "kv left behind (uninstall does not clear KV): $(curl -sf "$BASE/api/kv/_/ext-self-driving" "${AUTH[@]}" | jq '(.entries // []) | length')"
