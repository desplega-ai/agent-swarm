#!/bin/bash
set -euo pipefail

if ! command -v codex >/dev/null 2>&1; then
    echo "Error: codex CLI not found in PATH"
    exit 1
fi

if [ -z "${AGENT_ID:-}" ]; then
    echo "Error: AGENT_ID environment variable is required"
    exit 1
fi

AGENT_NAME="${AGENT_NAME:-codex-worker-${AGENT_ID}}"
LOOP_SLEEP_SECONDS="${CODEX_LOOP_SLEEP_SECONDS:-8}"
WORKER_ROOT="${WORKER_ROOT:-/workspace}"
APPROVAL_POLICY="${CODEX_APPROVAL_POLICY:-never}"
MCP_URL="${MCP_BASE_URL:-http://host.docker.internal:3013}"

running=true
handle_shutdown() {
    running=false
}
trap handle_shutdown SIGINT SIGTERM

read -r -d '' WORKER_PROMPT <<EOF || true
You are an always-on Codex external worker for Agent Swarm.

Identity:
- agent_id: ${AGENT_ID}
- agent_name: ${AGENT_NAME}
- role_profile: ${CODEX_ROLE_PROFILE:-builder_large}
- working_root: ${WORKER_ROOT}

Required operating contract:
1) Ensure registration:
   - First check get-swarm for an existing agent with id ${AGENT_ID}.
   - If missing, call join-swarm(lead=false, name="${AGENT_NAME}", description="Codex worker (${CODEX_ROLE_PROFILE:-builder_large})").
2) Acquire one task deterministically (pool/offers-first; do not require direct assignment):
   - Call get-tasks(mineOnly=true) first. If you already have one pending/in_progress task, continue that task and do not claim another.
   - Call poll-task once.
   - If poll-task returns offeredTasks, accept exactly one with task-action(action="accept", taskId="<offered_id>").
   - If poll-task indicates shouldExit=true, exit this run quickly.
   - If poll-task returns availableCount > 0 and no accepted/assigned task yet, call get-tasks(unassigned=true, readyOnly=true), choose one ready task, and call task-action(action="claim", taskId="<task_id>").
   - If claim fails due race, try one more ready task, then stop claiming.
3) If still no task after steps above, report there is no task and exit this run quickly.
4) If a task is assigned/accepted/claimed:
   - Record the exact task_id.
   - Before making any edits, create/switch to branch: swarm/${AGENT_ID}/<task_id>.
   - Use the exact \`swarm/<agent_id>/<task_id>\` branch pattern before edits.
   - Work only inside ${WORKER_ROOT}; do not use any shared checkout from other workers.
   - Lead owns dispatch packet edits by default. Do not directly edit docs/dispatch/* unless task explicitly authorizes it.
   - When dispatch updates are needed, propose exact text/diff via store-progress output.
   - Complete requested work, run targeted validation, and summarize results.
5) Always call store-progress at least once for any claimed task with:
   - changed files (or "no code changes")
   - commands run + results
   - PASS/WARN/FAIL status
   - risks/todos/blocked reasons

Security:
- Never print or echo secrets.
- Never include API keys/tokens in logs or task output.
EOF

should_run_worker_cycle() {
    local timestamp="$1"
    local poll_response=""
    local trigger_type=""

    poll_response="$(curl -sS --max-time 10 \
        -H "Authorization: Bearer ${API_KEY}" \
        -H "X-Agent-ID: ${AGENT_ID}" \
        "${MCP_URL%/}/api/poll" 2>/dev/null || true)"

    if [ -z "${poll_response}" ]; then
        echo "[${timestamp}] Poll precheck unavailable, running Codex fallback"
        return 0
    fi

    trigger_type="$(printf '%s' "${poll_response}" | jq -r '.trigger.type // empty' 2>/dev/null || true)"
    if [ -z "${trigger_type}" ]; then
        return 1
    fi

    echo "[${timestamp}] Trigger detected: ${trigger_type}"
    return 0
}

while [ "${running}" = "true" ]; do
    timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

    if ! should_run_worker_cycle "${timestamp}"; then
        echo "[${timestamp}] No trigger detected, skipping codex exec"
        sleep "${LOOP_SLEEP_SECONDS}"
        continue
    fi

    echo "[${timestamp}] Starting codex exec loop (${CODEX_ROLE_PROFILE:-builder_large})"

    set +e
    codex exec \
        --cd "${WORKER_ROOT}" \
        --skip-git-repo-check \
        --color never \
        --sandbox "${CODEX_SANDBOX:-workspace-write}" \
        --model "${CODEX_MODEL:-gpt-5.3-codex}" \
        -c "approval_policy=\"${APPROVAL_POLICY}\"" \
        -c "model_reasoning_effort=\"${CODEX_MODEL_REASONING_EFFORT:-xhigh}\"" \
        "${WORKER_PROMPT}"
    exit_code=$?
    set -e

    if [ "${exit_code}" -eq 0 ]; then
        echo "[${timestamp}] codex exec completed"
    else
        echo "[${timestamp}] codex exec exited with code ${exit_code}"
    fi

    if [ "${running}" != "true" ]; then
        break
    fi

    sleep "${LOOP_SLEEP_SECONDS}"
done

echo "Codex worker loop stopped"
