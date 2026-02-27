#!/bin/bash
set -euo pipefail

if [ -z "${API_KEY:-}" ]; then
    echo "Error: API_KEY environment variable is required"
    exit 1
fi

if [ -z "${AGENT_ID:-}" ]; then
    echo "Error: AGENT_ID environment variable is required"
    exit 1
fi

# Compatibility mapping for Codex auth naming.
if [ -n "${CODEX_API_KEY:-}" ] && [ -z "${OPENAI_API_KEY:-}" ]; then
    export OPENAI_API_KEY="${CODEX_API_KEY}"
fi

if [ -z "${OPENAI_API_KEY:-}" ]; then
    echo "Error: OPENAI_API_KEY (or CODEX_API_KEY) environment variable is required"
    exit 1
fi

ROLE_PROFILE="${CODEX_ROLE_PROFILE:-builder_large}"
MCP_URL="${MCP_BASE_URL:-http://host.docker.internal:3013}"
export AGENT_NAME="${AGENT_NAME:-codex-worker-${AGENT_ID}}"
export CODEX_HOME="${CODEX_HOME:-/workspace/personal/codex-home}"

apply_role_defaults() {
    case "$1" in
        planner)
            : "${CODEX_MODEL:=gpt-5.2}"
            : "${CODEX_MODEL_REASONING_EFFORT:=xhigh}"
            : "${CODEX_SANDBOX:=read-only}"
            ;;
        builder_large)
            : "${CODEX_MODEL:=gpt-5.3-codex}"
            : "${CODEX_MODEL_REASONING_EFFORT:=xhigh}"
            : "${CODEX_SANDBOX:=workspace-write}"
            ;;
        builder_tight)
            : "${CODEX_MODEL:=gpt-5.3-codex}"
            : "${CODEX_MODEL_REASONING_EFFORT:=high}"
            : "${CODEX_SANDBOX:=workspace-write}"
            ;;
        review_broad)
            : "${CODEX_MODEL:=gpt-5.2}"
            : "${CODEX_MODEL_REASONING_EFFORT:=xhigh}"
            : "${CODEX_SANDBOX:=read-only}"
            ;;
        review_perf)
            : "${CODEX_MODEL:=gpt-5.3-codex}"
            : "${CODEX_MODEL_REASONING_EFFORT:=xhigh}"
            : "${CODEX_SANDBOX:=read-only}"
            ;;
        *)
            echo "Error: unknown CODEX_ROLE_PROFILE='$1'"
            echo "Supported profiles: planner, builder_large, builder_tight, review_broad, review_perf"
            exit 1
            ;;
    esac
}

apply_role_defaults "${ROLE_PROFILE}"
export CODEX_MODEL
export CODEX_MODEL_REASONING_EFFORT
export CODEX_SANDBOX
export CODEX_APPROVAL_POLICY="${CODEX_APPROVAL_POLICY:-never}"

mkdir -p "${CODEX_HOME}" /workspace/personal /workspace/repos /workspace/tmp /logs
chmod 700 "${CODEX_HOME}"

# Keep Codex MCP wiring in persistent CODEX_HOME config.
cat > "${CODEX_HOME}/config.toml" <<EOF
[mcp_servers.agent-swarm]
url = "${MCP_URL%/}/mcp"
bearer_token_env_var = "API_KEY"
env_http_headers = { "X-Agent-ID" = "AGENT_ID" }
EOF

# Non-interactive API key login, once per container start.
if ! printenv OPENAI_API_KEY | codex login --with-api-key >/dev/null 2>&1; then
    echo "Error: codex login failed"
    exit 1
fi

if [ -n "${GITHUB_TOKEN:-}" ]; then
    gh auth setup-git >/dev/null 2>&1 || true
    git config --global user.email "${GITHUB_EMAIL:-worker-agent@desplega.ai}"
    git config --global user.name "${GITHUB_NAME:-Worker Agent}"
fi

echo "=== Codex Worker Bootstrap ==="
echo "Agent ID: ${AGENT_ID}"
echo "Agent Name: ${AGENT_NAME}"
echo "Role Profile: ${ROLE_PROFILE}"
echo "Model: ${CODEX_MODEL}"
echo "Reasoning Effort: ${CODEX_MODEL_REASONING_EFFORT}"
echo "Sandbox: ${CODEX_SANDBOX}"
echo "MCP URL: ${MCP_URL%/}/mcp"
echo "Workspace: /workspace"
echo "=============================="

exec /scripts/codex/worker-loop.sh
