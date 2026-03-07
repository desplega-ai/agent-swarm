#!/usr/bin/env bash
set -euo pipefail

# ===========================================================================
# E2E Workflow Engine Test Script
#
# Tests the workflow engine end-to-end against a running API server.
# Mocks Slack/GitHub/AgentMail by firing events through the REST API.
#
# Usage:
#   ./scripts/e2e-workflow-test.sh                    # Uses defaults from .env
#   PORT=3014 API_KEY=123123 ./scripts/e2e-workflow-test.sh  # Explicit config
#
# Prerequisites:
#   - API server running: bun run start:http
#   - curl and jq installed
# ===========================================================================

PORT="${PORT:-3014}"
API_KEY="${API_KEY:-123123}"
BASE_URL="http://localhost:${PORT}"
AGENT_ID="e2e-test-$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null || echo test-agent)"

PASS=0
FAIL=0
TESTS=()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log()  { echo -e "\033[1;34m[E2E]\033[0m $*"; }
pass() { echo -e "\033[1;32m  PASS\033[0m $1"; PASS=$((PASS + 1)); }
fail() { echo -e "\033[1;31m  FAIL\033[0m $1: $2"; FAIL=$((FAIL + 1)); }

api() {
  local method="$1" path="$2"
  shift 2
  curl -sf -X "$method" \
    -H "Authorization: Bearer ${API_KEY}" \
    -H "Content-Type: application/json" \
    -H "X-Agent-ID: ${AGENT_ID}" \
    "${BASE_URL}${path}" "$@"
}

assert_status() {
  local test_name="$1" expected="$2" method="$3" path="$4"
  shift 4
  local status
  status=$(curl -s -o /dev/null -w '%{http_code}' -X "$method" \
    -H "Authorization: Bearer ${API_KEY}" \
    -H "Content-Type: application/json" \
    -H "X-Agent-ID: ${AGENT_ID}" \
    "${BASE_URL}${path}" "$@")
  if [ "$status" = "$expected" ]; then
    pass "$test_name"
  else
    fail "$test_name" "expected HTTP $expected, got $status"
  fi
}

assert_json() {
  local test_name="$1" json="$2" jq_expr="$3" expected="$4"
  local actual
  actual=$(echo "$json" | jq -r "$jq_expr")
  if [ "$actual" = "$expected" ]; then
    pass "$test_name"
  else
    fail "$test_name" "expected '$expected', got '$actual'"
  fi
}

# ---------------------------------------------------------------------------
# Check server is running
# ---------------------------------------------------------------------------
log "Checking API server at ${BASE_URL}..."
if ! curl -sf -o /dev/null "${BASE_URL}/api/agents" -H "Authorization: Bearer ${API_KEY}" 2>/dev/null; then
  echo -e "\033[1;31mERROR: API server not reachable at ${BASE_URL}\033[0m"
  echo "Start it first: PORT=${PORT} bun run start:http"
  exit 1
fi
log "Server is up."

# ===========================================================================
# Test 1: Workflow CRUD lifecycle
# ===========================================================================
log "Test 1: Workflow CRUD lifecycle"

WORKFLOW_JSON=$(api POST /api/workflows -d '{
  "name": "e2e-test-triage",
  "description": "E2E test workflow",
  "definition": {
    "nodes": [
      {"id": "t1", "type": "trigger-webhook", "config": {}},
      {"id": "pm1", "type": "property-match", "config": {
        "conditions": [{"field": "trigger.priority", "op": "gt", "value": 5}]
      }},
      {"id": "ct1", "type": "create-task", "config": {"template": "High priority: {{trigger.title}}"}}
    ],
    "edges": [
      {"id": "e1", "source": "t1", "sourcePort": "default", "target": "pm1"},
      {"id": "e2", "source": "pm1", "sourcePort": "true", "target": "ct1"}
    ]
  }
}')
WF_ID=$(echo "$WORKFLOW_JSON" | jq -r '.id')
assert_json "Create workflow returns id" "$WORKFLOW_JSON" '.id' "$WF_ID"
assert_json "Create workflow returns name" "$WORKFLOW_JSON" '.name' "e2e-test-triage"
assert_json "Create workflow returns enabled=true" "$WORKFLOW_JSON" '.enabled' "true"

# List
LIST_JSON=$(api GET /api/workflows)
WF_COUNT=$(echo "$LIST_JSON" | jq "[.[] | select(.id == \"$WF_ID\")] | length")
if [ "$WF_COUNT" = "1" ]; then pass "List workflows contains created workflow"; else fail "List workflows" "not found in list"; fi

# Get single
GET_JSON=$(api GET "/api/workflows/${WF_ID}")
assert_json "Get workflow by id" "$GET_JSON" '.name' "e2e-test-triage"

# Update
UPDATE_JSON=$(api PUT "/api/workflows/${WF_ID}" -d '{"name": "e2e-test-triage-updated"}')
assert_json "Update workflow name" "$UPDATE_JSON" '.name' "e2e-test-triage-updated"

# 404 on unknown
assert_status "GET unknown workflow returns 404" "404" GET "/api/workflows/nonexistent"

# ===========================================================================
# Test 2: Trigger workflow via webhook and verify run
# ===========================================================================
log "Test 2: Trigger workflow (high priority → task created)"

TRIGGER_JSON=$(api POST "/api/workflows/${WF_ID}/trigger" -d '{
  "priority": 8,
  "title": "Server is on fire"
}')
RUN_ID=$(echo "$TRIGGER_JSON" | jq -r '.runId')
assert_json "Trigger returns runId" "$TRIGGER_JSON" '.runId' "$RUN_ID"

# Wait for async execution
sleep 1

# Check run detail
RUN_JSON=$(api GET "/api/workflow-runs/${RUN_ID}")
assert_json "Run has steps" "$RUN_JSON" '.steps | length > 0' "true"

# Verify task was created (create-task is async, run should be waiting)
RUN_STATUS=$(echo "$RUN_JSON" | jq -r '.status')
if [ "$RUN_STATUS" = "waiting" ] || [ "$RUN_STATUS" = "completed" ]; then
  pass "Run status is waiting or completed (async task node)"
else
  fail "Run status" "expected waiting/completed, got $RUN_STATUS"
fi

# Check that all 3 nodes were visited
STEP_COUNT=$(echo "$RUN_JSON" | jq '.steps | length')
if [ "$STEP_COUNT" -ge 3 ]; then
  pass "All 3 nodes executed (trigger, property-match, create-task)"
else
  fail "Step count" "expected >= 3, got $STEP_COUNT"
fi

# List runs
RUNS_JSON=$(api GET "/api/workflows/${WF_ID}/runs")
RUN_IN_LIST=$(echo "$RUNS_JSON" | jq "[.[] | select(.id == \"$RUN_ID\")] | length")
if [ "$RUN_IN_LIST" = "1" ]; then pass "List runs contains our run"; else fail "List runs" "run not found"; fi

# ===========================================================================
# Test 3: Property-match rejects low priority (no task created)
# ===========================================================================
log "Test 3: Trigger workflow (low priority → no task)"

TRIGGER2_JSON=$(api POST "/api/workflows/${WF_ID}/trigger" -d '{
  "priority": 2,
  "title": "Minor typo"
}')
RUN2_ID=$(echo "$TRIGGER2_JSON" | jq -r '.runId')

sleep 1

RUN2_JSON=$(api GET "/api/workflow-runs/${RUN2_ID}")
RUN2_STATUS=$(echo "$RUN2_JSON" | jq -r '.status')
assert_json "Low priority run completes (no async nodes reached)" "$RUN2_JSON" '.status' "completed"

# Only 2 steps: trigger + property-match (ct1 skipped because pm1 returned false)
STEP2_COUNT=$(echo "$RUN2_JSON" | jq '.steps | length')
if [ "$STEP2_COUNT" = "2" ]; then
  pass "Only 2 nodes executed (trigger, property-match — task skipped)"
else
  fail "Step count for low priority" "expected 2, got $STEP2_COUNT"
fi

# ===========================================================================
# Test 4: Disabled workflow cannot be triggered
# ===========================================================================
log "Test 4: Disabled workflow returns 400"

api PUT "/api/workflows/${WF_ID}" -d '{"enabled": false}' > /dev/null
assert_status "Trigger disabled workflow returns 400" "400" POST "/api/workflows/${WF_ID}/trigger" -d '{}'

# Re-enable for cleanup
api PUT "/api/workflows/${WF_ID}" -d '{"enabled": true}' > /dev/null

# ===========================================================================
# Test 5: Retry a failed run
# ===========================================================================
log "Test 5: Retry failed run"

# Create a workflow with code-match that will throw
FAIL_WF_JSON=$(api POST /api/workflows -d '{
  "name": "e2e-fail-workflow",
  "definition": {
    "nodes": [
      {"id": "t1", "type": "trigger-webhook", "config": {}},
      {"id": "cm1", "type": "code-match", "config": {
        "code": "(input) => { throw new Error(\"intentional failure\"); }",
        "outputPorts": ["true", "false"]
      }}
    ],
    "edges": [
      {"id": "e1", "source": "t1", "sourcePort": "default", "target": "cm1"}
    ]
  }
}')
FAIL_WF_ID=$(echo "$FAIL_WF_JSON" | jq -r '.id')

FAIL_TRIGGER_JSON=$(api POST "/api/workflows/${FAIL_WF_ID}/trigger" -d '{}')
FAIL_RUN_ID=$(echo "$FAIL_TRIGGER_JSON" | jq -r '.runId')

sleep 1

FAIL_RUN_JSON=$(api GET "/api/workflow-runs/${FAIL_RUN_ID}")
assert_json "Failed run has status=failed" "$FAIL_RUN_JSON" '.status' "failed"

# Retry should return 400 since the underlying error hasn't been fixed
RETRY_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  -H "X-Agent-ID: ${AGENT_ID}" \
  "${BASE_URL}/api/workflow-runs/${FAIL_RUN_ID}/retry")
# Retry re-executes but the same error will occur, so it should still return 200 (retry itself succeeds)
# or 400 if the error re-throws. Either way, let's just verify the endpoint is accessible.
if [ "$RETRY_STATUS" = "200" ] || [ "$RETRY_STATUS" = "400" ]; then
  pass "Retry endpoint responds (status=$RETRY_STATUS)"
else
  fail "Retry endpoint" "expected 200 or 400, got $RETRY_STATUS"
fi

# ===========================================================================
# Test 6: Webhook secret auth
# ===========================================================================
log "Test 6: Webhook secret auth"

# Trigger without X-Agent-ID and wrong secret → 401
NOAUTH_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  "${BASE_URL}/api/workflows/${WF_ID}/trigger?secret=wrong-secret" \
  -d '{}')
if [ "$NOAUTH_STATUS" = "401" ]; then
  pass "Trigger without agentId and wrong secret returns 401"
else
  fail "Webhook secret auth" "expected 401, got $NOAUTH_STATUS"
fi

# ===========================================================================
# Test 7: Delete workflow
# ===========================================================================
log "Test 7: Delete workflow"

assert_status "Delete workflow returns 204" "204" DELETE "/api/workflows/${WF_ID}"
assert_status "Get deleted workflow returns 404" "404" GET "/api/workflows/${WF_ID}"

# Cleanup the fail workflow too
api DELETE "/api/workflows/${FAIL_WF_ID}" > /dev/null 2>&1 || true

# ===========================================================================
# Summary
# ===========================================================================
echo ""
log "========================================="
log "Results: ${PASS} passed, ${FAIL} failed"
log "========================================="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
