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

LOOP_SLEEP_SECONDS="${CODEX_LOOP_SLEEP_SECONDS:-8}"
WORKER_ROOT="${WORKER_ROOT:-/workspace}"
APPROVAL_POLICY="${CODEX_APPROVAL_POLICY:-never}"

running=true
handle_shutdown() {
    running=false
}
trap handle_shutdown SIGINT SIGTERM

read -r -d '' WORKER_PROMPT <<EOF || true
You are an always-on Codex external worker for Agent Swarm.

Identity:
- agent_id: ${AGENT_ID}
- role_profile: ${CODEX_ROLE_PROFILE:-builder_large}
- working_root: ${WORKER_ROOT}

Required operating contract:
1) Join swarm first as a non-lead worker using the MCP tools.
2) Poll for exactly one task (pool/offers routing by default; do not require direct assignment).
3) If no task is available, report that there is no task and exit this run quickly.
4) If a task is available:
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

while [ "${running}" = "true" ]; do
    timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
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
