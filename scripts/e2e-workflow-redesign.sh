#!/usr/bin/env bash
# scripts/e2e-workflow-redesign.sh
# Run: bash scripts/e2e-workflow-redesign.sh
# Requires: API server NOT running on port 3013 (script starts its own)
set -euo pipefail

# Source .env for PORT and API_KEY (Bun auto-loads it for the server, but bash doesn't)
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

E2E_PORT="${PORT:-3013}"
API="http://localhost:$E2E_PORT"
AUTH="Authorization: Bearer ${API_KEY:-123123}"
AGENT_HDR="X-Agent-ID: 00000000-0000-0000-0000-000000000001"
CT="Content-Type: application/json"
PASS=0; FAIL=0; TOTAL=0

# ── Helpers ──────────────────────────────────────────────────
assert_eq() {
  TOTAL=$((TOTAL + 1))
  local label="$1" actual="$2" expected="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  ✓ $label"; PASS=$((PASS + 1))
  else
    echo "  ✗ $label (expected '$expected', got '$actual')"; FAIL=$((FAIL + 1))
  fi
}

assert_neq() {
  TOTAL=$((TOTAL + 1))
  local label="$1" actual="$2" unexpected="$3"
  if [ "$actual" != "$unexpected" ]; then
    echo "  ✓ $label"; PASS=$((PASS + 1))
  else
    echo "  ✗ $label (got unexpected '$unexpected')"; FAIL=$((FAIL + 1))
  fi
}

create_workflow() {
  curl -s -X POST "$API/api/workflows" -H "$AUTH" -H "$AGENT_HDR" -H "$CT" -d "$1" | jq -r '.id'
}

trigger_workflow() {
  curl -s -X POST "$API/api/workflows/$1/trigger" -H "$AUTH" -H "$AGENT_HDR" -H "$CT" -d "${2:-{}}" | jq -r '.runId'
}

wait_run() {
  local run_id="$1" max_wait="${2:-5}" i=0
  while [ $i -lt $max_wait ]; do
    local status
    status=$(curl -s "$API/api/workflow-runs/$run_id" -H "$AUTH" -H "$AGENT_HDR" | jq -r '.run.status')
    if [ "$status" != "running" ]; then echo "$status"; return; fi
    sleep 1; i=$((i + 1))
  done
  echo "timeout"
}

get_run() {
  curl -s "$API/api/workflow-runs/$1" -H "$AUTH" -H "$AGENT_HDR"
}

cleanup() {
  echo ""; echo "Cleaning up..."
  kill $(lsof -ti :$E2E_PORT 2>/dev/null) 2>/dev/null || true
  rm -f agent-swarm-db.sqlite agent-swarm-db.sqlite-wal agent-swarm-db.sqlite-shm
}
trap cleanup EXIT

# ── Setup ────────────────────────────────────────────────────
echo "=== E2E Workflow Redesign Tests ==="
echo ""
rm -f agent-swarm-db.sqlite agent-swarm-db.sqlite-wal agent-swarm-db.sqlite-shm
SLACK_DISABLE=true GITHUB_DISABLE=true bun run start:http &
# Wait for server to be ready (health check with retry)
for i in $(seq 1 10); do
  curl -sf "$API/api/agents" -H "$AUTH" > /dev/null 2>&1 && break
  [ $i -eq 10 ] && { echo "Server failed to start"; exit 1; }
  sleep 1
done

# ── Test 1: Linear happy path ───────────────────────────────
echo "Test 1: Linear happy path"
WF1=$(create_workflow '{
  "name": "e2e-linear",
  "definition": { "nodes": [
    { "id": "s1", "type": "script", "config": { "runtime": "bash", "script": "echo hello" }, "next": "check" },
    { "id": "check", "type": "property-match", "config": { "conditions": [{ "field": "s1.exitCode", "op": "eq", "value": 0 }] }, "next": { "true": "done", "false": "fail" } },
    { "id": "done", "type": "notify", "config": { "channel": "swarm", "template": "OK: {{s1.stdout}}" } },
    { "id": "fail", "type": "notify", "config": { "channel": "swarm", "template": "FAIL" } }
  ]}
}')
RUN1=$(trigger_workflow "$WF1")
STATUS1=$(wait_run "$RUN1")
STEPS1=$(get_run "$RUN1" | jq '.steps | length')
assert_eq "run completes" "$STATUS1" "completed"
assert_eq "3 steps executed" "$STEPS1" "3"

# ── Test 2: Branch false path ───────────────────────────────
echo "Test 2: Branch false path (script fails)"
WF2=$(create_workflow '{
  "name": "e2e-branch-false",
  "definition": { "nodes": [
    { "id": "s1", "type": "script", "config": { "runtime": "bash", "script": "exit 1" }, "next": "check" },
    { "id": "check", "type": "property-match", "config": { "conditions": [{ "field": "s1.exitCode", "op": "eq", "value": 0 }] }, "next": { "true": "ok", "false": "notok" } },
    { "id": "ok", "type": "notify", "config": { "channel": "swarm", "template": "OK" } },
    { "id": "notok", "type": "notify", "config": { "channel": "swarm", "template": "NOT OK" } }
  ]}
}')
RUN2=$(trigger_workflow "$WF2")
STATUS2=$(wait_run "$RUN2")
LAST_STEP2=$(get_run "$RUN2" | jq -r '.steps[-1].nodeId')
assert_eq "run completes" "$STATUS2" "completed"
assert_eq "takes false branch" "$LAST_STEP2" "notok"

# ── Test 3: Multi-executor chain with context flow ──────────
echo "Test 3: Multi-executor chain (script → code-match → notify)"
WF3=$(create_workflow '{
  "name": "e2e-chain",
  "definition": { "nodes": [
    { "id": "s1", "type": "script", "config": { "runtime": "bash", "script": "echo 42" }, "next": "eval" },
    { "id": "eval", "type": "code-match", "config": { "code": "(input) => (input.s1.exitCode === 0) ? \"ok\" : \"err\"", "outputPorts": ["ok", "err"] }, "next": { "ok": "done", "err": "fail" } },
    { "id": "done", "type": "notify", "config": { "channel": "swarm", "template": "Result: {{s1.stdout}}" } },
    { "id": "fail", "type": "notify", "config": { "channel": "swarm", "template": "Error" } }
  ]}
}')
RUN3=$(trigger_workflow "$WF3")
STATUS3=$(wait_run "$RUN3")
STEPS3=$(get_run "$RUN3" | jq '.steps | length')
assert_eq "run completes" "$STATUS3" "completed"
assert_eq "3 steps executed (script → code-match → notify)" "$STEPS3" "3"

# ── Test 4: Async pause/resume ──────────────────────────────
echo "Test 4: Async pause/resume (agent-task)"
WF4=$(create_workflow '{
  "name": "e2e-async",
  "definition": { "nodes": [
    { "id": "s1", "type": "script", "config": { "runtime": "bash", "script": "echo prep" }, "next": "task" },
    { "id": "task", "type": "agent-task", "config": { "template": "Do something: {{s1.stdout}}" }, "next": "done" },
    { "id": "done", "type": "notify", "config": { "channel": "swarm", "template": "Task output: {{task.taskOutput}}" } }
  ]}
}')
RUN4=$(trigger_workflow "$WF4")
STATUS4=$(wait_run "$RUN4" 3)
assert_eq "run pauses at waiting" "$STATUS4" "waiting"
# Find the created task
TASK_ID=$(curl -s "$API/api/tasks?source=workflow" -H "$AUTH" -H "$AGENT_HDR" | jq -r '.tasks[0].id')
assert_neq "task was created" "$TASK_ID" "null"
# Assign and start the task (no HTTP endpoint for this, use sqlite)
sqlite3 agent-swarm-db.sqlite "UPDATE agent_tasks SET status='in_progress', agentId='00000000-0000-0000-0000-000000000001' WHERE id='$TASK_ID'"
# Complete the task via HTTP (triggers event bus → workflow resume)
curl -s -X POST "$API/api/tasks/$TASK_ID/finish" -H "$AUTH" -H "$AGENT_HDR" -H "$CT" \
  -d '{"status": "completed", "output": "task done"}' > /dev/null
sleep 4
STATUS4B=$(curl -s "$API/api/workflow-runs/$RUN4" -H "$AUTH" -H "$AGENT_HDR" | jq -r '.run.status')
assert_eq "run resumes to completed" "$STATUS4B" "completed"

# ── Test 5: Webhook trigger + HMAC ──────────────────────────
echo "Test 5: Webhook trigger + HMAC"
WF5=$(create_workflow '{
  "name": "e2e-webhook",
  "definition": { "nodes": [
    { "id": "n1", "type": "notify", "config": { "channel": "swarm", "template": "Webhook fired: {{trigger}}" } }
  ]},
  "triggers": [{ "type": "webhook", "hmacSecret": "test-secret-123" }]
}')
# Valid HMAC
BODY='{"event":"test"}'
SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "test-secret-123" | awk '{print "sha256="$2}')
WEBHOOK_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API/api/webhooks/$WF5" \
  -H "$CT" -H "X-Hub-Signature-256: $SIG" -d "$BODY")
assert_eq "valid HMAC → 201" "$WEBHOOK_STATUS" "201"
# Invalid HMAC
BAD_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API/api/webhooks/$WF5" \
  -H "$CT" -H "X-Hub-Signature-256: sha256=invalid" -d "$BODY")
assert_eq "invalid HMAC → 401" "$BAD_STATUS" "401"

# ── Test 6: Cooldown skip ───────────────────────────────────
echo "Test 6: Cooldown skip"
WF6=$(create_workflow '{
  "name": "e2e-cooldown",
  "definition": { "nodes": [
    { "id": "n1", "type": "notify", "config": { "channel": "swarm", "template": "Ran" } }
  ]},
  "cooldown": { "hours": 1 }
}')
RUN6A=$(trigger_workflow "$WF6")
STATUS6A=$(wait_run "$RUN6A")
assert_eq "first run completes" "$STATUS6A" "completed"
RUN6B=$(trigger_workflow "$WF6")
STATUS6B=$(wait_run "$RUN6B" 2)
assert_eq "second run skipped (cooldown)" "$STATUS6B" "skipped"

# ── Test 7: Version history ─────────────────────────────────
echo "Test 7: Version history"
WF7=$(create_workflow '{
  "name": "e2e-versions",
  "definition": { "nodes": [
    { "id": "n1", "type": "notify", "config": { "channel": "swarm", "template": "v1" } }
  ]}
}')
curl -s -X PUT "$API/api/workflows/$WF7" -H "$AUTH" -H "$AGENT_HDR" -H "$CT" \
  -d '{"description": "update 1"}' > /dev/null
curl -s -X PUT "$API/api/workflows/$WF7" -H "$AUTH" -H "$AGENT_HDR" -H "$CT" \
  -d '{"description": "update 2"}' > /dev/null
VERSIONS=$(sqlite3 agent-swarm-db.sqlite "SELECT COUNT(*) FROM workflow_versions WHERE workflowId='$WF7'")
assert_eq "2 version snapshots" "$VERSIONS" "2"

# ── Test 8: Validation failure (mustPass) ────────────────────
echo "Test 8: Validation failure halts run"
WF8=$(create_workflow '{
  "name": "e2e-validation-fail",
  "definition": { "nodes": [
    { "id": "s1", "type": "script", "config": { "runtime": "bash", "script": "echo bad-data" },
      "validation": { "executor": "validate", "config": { "targetNodeId": "s1", "schema": { "type": "object", "properties": { "stdout": { "const": "good-data" } } } }, "mustPass": true },
      "next": "done" },
    { "id": "done", "type": "notify", "config": { "channel": "swarm", "template": "Should not reach" } }
  ]}
}')
RUN8=$(trigger_workflow "$WF8")
STATUS8=$(wait_run "$RUN8")
assert_eq "run fails on validation" "$STATUS8" "failed"

# ── Summary ──────────────────────────────────────────────────
echo ""
echo "=== Results: $PASS/$TOTAL passed, $FAIL failed ==="
if [ $FAIL -gt 0 ]; then exit 1; fi
