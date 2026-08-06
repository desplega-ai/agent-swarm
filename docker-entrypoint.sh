#!/bin/bash
set -e

# ─── Boot model ──────────────────────────────────────────────────────────────
# Harness-credential validation is intentionally NON-FATAL here. The worker
# process runs a TS-level wait loop (`src/commands/credential-wait.ts`) that
# parks the worker after `join-swarm` if creds are missing, polling
# `swarm_config` until they appear. This script does best-effort prep
# (codex login, codex_oauth restore, claude-managed pre-fetch) and emits
# warnings when a provider's expected env vars / files are absent.
#
# The ONLY hard-exit on missing config is `API_KEY` — it's the bootstrap
# requirement for the worker to talk to the API at all, and there's no
# recovery path without it.
#
# See thoughts/taras/plans/2026-05-06-worker-credential-safe-loop.md.
# ────────────────────────────────────────────────────────────────────────────

# Validate required environment variables based on provider
HARNESS_PROVIDER="${HARNESS_PROVIDER:-claude}"

# Role defaults to worker, can be set to "lead". Resolved here (rather than
# later in the file) because the API-readiness gate below needs MCP_URL
# before any provider-specific block reads the control-plane API.
ROLE="${AGENT_ROLE:-worker}"
MCP_URL="${MCP_BASE_URL:-http://host.docker.internal:3013}"

if [ -z "$API_KEY" ]; then
    echo "Error: API_KEY environment variable is required"
    exit 1
fi

# ─── API readiness gate ──────────────────────────────────────────────────────
# The control-plane API must be reachable before ANY provider-specific setup
# reads it — the claude-managed / codex OAuth restore blocks immediately
# below both fetch swarm_config over HTTP. A worker that can't reach the API
# can't poll tasks either, so a half-provisioned worker that limps into
# credential-wait with no config is worse than a container that exits
# cleanly. Bounded so a dead API never blocks boot forever. Timeout is
# operator-tunable via WORKER_API_READY_TIMEOUT_SECONDS — see
# apps/ui/src/lib/configuration-catalog.ts.
# BEGIN wait_for_api_ready (extracted verbatim by src/tests/entrypoint-api-readiness.test.ts — keep markers stable)
wait_for_api_ready() {
    local base_url="$1"
    local url="${base_url%/}/health"
    local timeout_raw="${WORKER_API_READY_TIMEOUT_SECONDS:-90}"

    case "$timeout_raw" in
        ''|*[!0-9]*)
            echo "[entrypoint] FATAL: WORKER_API_READY_TIMEOUT_SECONDS must be a positive integer, got '${timeout_raw}'; exiting."
            exit 1
            ;;
    esac
    if [ "$timeout_raw" -le 0 ]; then
        echo "[entrypoint] FATAL: WORKER_API_READY_TIMEOUT_SECONDS must be a positive integer, got '${timeout_raw}'; exiting."
        exit 1
    fi

    local deadline=$(( $(date +%s) + timeout_raw ))
    echo "[entrypoint] Waiting for API readiness at ${url} (timeout ${timeout_raw}s)..."
    while true; do
        if curl -sf --connect-timeout 2 --max-time 3 -o /dev/null "$url"; then
            echo "[entrypoint] API ready at ${url}"
            return 0
        fi
        if [ "$(date +%s)" -ge "$deadline" ]; then
            echo "[entrypoint] FATAL: API readiness timed out after ${timeout_raw}s waiting for ${url}; exiting."
            exit 1
        fi
        sleep 1
    done
}
# END wait_for_api_ready

wait_for_api_ready "$MCP_URL"

if [ "$HARNESS_PROVIDER" = "pi" ]; then
    # Pi-mono auth: ANTHROPIC_API_KEY, OPENROUTER_API_KEY, or auth.json must
    # exist — UNLESS MODEL_OVERRIDE selects amazon-bedrock, in which case
    # credential resolution is delegated to the AWS SDK at first inference
    # call (env vars, ~/.aws/*, SSO, IMDS, assume-role, etc.). The boot gate
    # in checkPiMonoCredentials short-circuits to satisfiedBy=sdk-delegated
    # for that case, so don't emit a misleading warning here.
    case "$(echo "${MODEL_OVERRIDE:-}" | tr '[:upper:]' '[:lower:]')" in
        amazon-bedrock/*)
            echo "pi provider: MODEL_OVERRIDE=${MODEL_OVERRIDE} — AWS SDK will resolve Bedrock credentials at runtime (env, ~/.aws/*, SSO, IMDS)."
            ;;
        *)
            if [ -z "$ANTHROPIC_API_KEY" ] && [ -z "$OPENROUTER_API_KEY" ] && [ ! -f "$HOME/.pi/agent/auth.json" ]; then
                echo "Warning: pi provider has no credentials yet (ANTHROPIC_API_KEY / OPENROUTER_API_KEY / ~/.pi/agent/auth.json). Worker will park in credential-wait until creds appear in swarm_config."
            fi
            ;;
    esac
elif [ "$HARNESS_PROVIDER" = "opencode" ]; then
    # opencode auth: OPENROUTER_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, or auth.json must exist
    OPENCODE_AUTH_FILE="${HOME}/.local/share/opencode/auth.json"
    if [ -z "$OPENROUTER_API_KEY" ] && [ -z "$ANTHROPIC_API_KEY" ] && [ -z "$OPENAI_API_KEY" ] && [ ! -f "$OPENCODE_AUTH_FILE" ]; then
        echo "Warning: opencode provider has no credentials yet (OPENROUTER_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY / ${OPENCODE_AUTH_FILE}). Worker will park in credential-wait until creds appear in swarm_config."
    fi
elif [ "$HARNESS_PROVIDER" = "claude-managed" ]; then
    # Claude Managed Agents — sessions run in Anthropic's cloud sandbox.
    # No CLI binary needed; the worker process is a thin SSE relay.
    #
    # Required env vars (all four):
    #   ANTHROPIC_API_KEY       — credential for the SDK
    #   MANAGED_AGENT_ID        — pre-created agent (claude-managed-setup)
    #   MANAGED_ENVIRONMENT_ID  — pre-created environment (claude-managed-setup)
    #   MCP_BASE_URL            — public HTTPS URL where Anthropic can reach /mcp
    #
    # Restoration order: respect externally-set env vars first; only fall back
    # to swarm_config when missing. Mirrors the codex_oauth restoration block
    # above (L13-71) — same fetch endpoint, different keys.
    if [ -n "$API_KEY" ] && [ -n "$MCP_BASE_URL" ]; then
        for KEY_TUPLE in "ANTHROPIC_API_KEY:anthropic_api_key" \
                         "MANAGED_AGENT_ID:managed_agent_id" \
                         "MANAGED_ENVIRONMENT_ID:managed_environment_id" \
                         "MANAGED_MCP_VAULT_ID:managed_mcp_vault_id"; do
            ENV_VAR="${KEY_TUPLE%%:*}"
            CONFIG_KEY="${KEY_TUPLE##*:}"
            # Only fill if the env var isn't already set externally.
            if [ -z "$(eval "echo \$$ENV_VAR")" ]; then
                VALUE=$(curl -sf -H "Authorization: Bearer ${API_KEY}" \
                    "${MCP_BASE_URL}/api/config/resolved?includeSecrets=true&key=${CONFIG_KEY}" \
                    2>/dev/null | jq -r ".configs[] | select(.key == \"${CONFIG_KEY}\") | .value // empty" 2>/dev/null | head -1)
                if [ -n "$VALUE" ]; then
                    export "$ENV_VAR=$VALUE"
                    echo "[entrypoint] Restored claude-managed config from swarm_config: $ENV_VAR"
                fi
            fi
        done
    fi

    # Soft-validate the four required env vars (TS-level loop will block until ready).
    MISSING=""
    [ -z "$ANTHROPIC_API_KEY" ] && MISSING="$MISSING ANTHROPIC_API_KEY"
    [ -z "$MANAGED_AGENT_ID" ] && MISSING="$MISSING MANAGED_AGENT_ID"
    [ -z "$MANAGED_ENVIRONMENT_ID" ] && MISSING="$MISSING MANAGED_ENVIRONMENT_ID"
    [ -z "$MCP_BASE_URL" ] && MISSING="$MISSING MCP_BASE_URL"
    if [ -n "$MISSING" ]; then
        echo "Warning: claude-managed provider missing:$MISSING"
        echo "  Run \`bun run src/cli.tsx claude-managed-setup\` from your laptop to create"
        echo "  the Anthropic-side agent + environment and persist their IDs to swarm_config."
        echo "  MCP_BASE_URL must be a public HTTPS URL (ngrok / Cloudflare Tunnel in dev)."
        echo "  Worker will park in credential-wait until they appear."
    fi
elif [ "$HARNESS_PROVIDER" = "devin" ]; then
    # Devin auth: DEVIN_API_KEY and DEVIN_ORG_ID must exist (soft check; TS loop blocks).
    if [ -z "$DEVIN_API_KEY" ] || [ -z "$DEVIN_ORG_ID" ]; then
        echo "Warning: devin provider missing DEVIN_API_KEY / DEVIN_ORG_ID. Worker will park in credential-wait until they appear in swarm_config."
    else
        echo "Devin API: configured (org: ${DEVIN_ORG_ID})"
    fi
elif [ "$HARNESS_PROVIDER" = "codex" ]; then
    WORKER_CODEX_HOME="/home/worker/.codex"

    # If a stale api-key-mode auth.json is on disk, drop it so the OAuth path
    # below can write fresh chatgpt-mode credentials. (codex_oauth wins over
    # OPENAI_API_KEY — the prior boot may have written an api-key auth.json
    # before this precedence flip.) Keep an existing chatgpt-mode auth.json
    # in place; the runtime adapter handles refresh-on-stale.
    if [ -f "$WORKER_CODEX_HOME/auth.json" ]; then
        EXISTING_AUTH_MODE=$(jq -r '.auth_mode // empty' "$WORKER_CODEX_HOME/auth.json" 2>/dev/null || echo "")
        if [ "$EXISTING_AUTH_MODE" != "chatgpt" ]; then
            rm -f "$WORKER_CODEX_HOME/auth.json"
        fi
    fi

    # Auth path 1: Seed slot 0 from swarm config store at boot (backwards-compat),
    # falling back to a plain CODEX_OAUTH container env var when the config
    # store has nothing. Tries codex_oauth_0 first (post-migration 071), then
    # legacy codex_oauth key, then $CODEX_OAUTH. Runner handles per-task
    # materialization for multi-slot pools; this is only a boot-time seed so
    # the credential-wait loop sees auth.json on fresh containers.
    #
    # `checkCodexCredentials` (codex-adapter.ts) treats a bare CODEX_OAUTH env
    # var as `satisfiedBy: 'side-effect-pending'` — i.e. it trusts THIS block
    # to materialise ~/.codex/auth.json from it. Previously nothing did: this
    # block only ever queried the config store, so a container-only
    # CODEX_OAUTH was never written to disk and every task auth-errored
    # (issue #1102 bug 1, repro 2). Resolving into a *different* local
    # variable (not reusing the `CODEX_OAUTH` name) also fixes a second,
    # compounding bug: the old code did `CODEX_OAUTH=$(curl ... )`, which
    # clobbered the container-provided $CODEX_OAUTH with an empty string
    # whenever the config store had no row — destroying the very env var the
    # boot gate said was present, which is why the boot loop kept reporting
    # it "missing" despite it genuinely being set and valid.
    #
    # The refresh token is deliberately blanked below (matching the
    # runner/adapter pool auth.json — see credentialsToAuthJson in
    # auth-json.ts): this boot-seeded file is the last place a live pool
    # refresh token could otherwise land on worker disk, and any Codex CLI
    # run against it before the runner's first per-task overwrite
    # (credential-wait probes, manual runs, crash loops) would self-refresh
    # outside the /api/oauth/refresh-locks lock — an unlocked rotation that
    # can revoke the whole token family. A container-provided CODEX_OAUTH is
    # single-slot/non-pool, so this is a one-time seed same as the
    # config-store path — the runner never refreshes it back to a
    # `codex_oauth_<n>` config-store slot.
    # Gate on MCP_URL (already defaulted at L26), not the raw MCP_BASE_URL —
    # a standalone container that relies on the default API URL would
    # otherwise never reach the CODEX_OAUTH env-var fallback below, even
    # though every other API call in this script (wait_for_api_ready,
    # /ecosystem, /api/repos, etc.) already treats MCP_URL as "the" base
    # URL. checkCodexCredentials (codex-adapter.ts) marks a bare CODEX_OAUTH
    # as satisfiedBy: 'side-effect-pending' the moment it's set, trusting
    # this block to write auth.json — so gating on the unset raw var meant
    # the boot gate reported ready while no auth.json ever materialized and
    # every task auth-errored.
    if [ ! -f "$WORKER_CODEX_HOME/auth.json" ] && [ -n "$API_KEY" ] && [ -n "$MCP_URL" ]; then
        CODEX_OAUTH_SEED=$(curl -sf -H "Authorization: Bearer ${API_KEY}" \
            "${MCP_URL}/api/config/resolved?includeSecrets=true" \
            2>/dev/null | jq -r '
              (.configs[] | select(.key == "codex_oauth_0") | .value // empty),
              (.configs[] | select(.key == "codex_oauth") | .value // empty)
            ' 2>/dev/null | head -1)
        CODEX_OAUTH_SEED_STANDALONE=false
        if [ -z "$CODEX_OAUTH_SEED" ] && [ -n "${CODEX_OAUTH:-}" ]; then
            CODEX_OAUTH_SEED="$CODEX_OAUTH"
            CODEX_OAUTH_SEED_STANDALONE=true
            echo "[entrypoint] No codex_oauth_0/codex_oauth in config store; seeding from CODEX_OAUTH env var"
        fi
        if [ -n "$CODEX_OAUTH_SEED" ]; then
            if ! echo "$CODEX_OAUTH_SEED" | jq '.' >/dev/null 2>&1; then
                echo "Warning: codex_oauth source is not valid JSON, skipping" >&2
            else
                mkdir -p "$WORKER_CODEX_HOME"
                # Refresh token handling depends on the source: config-store
                # pool credentials get their refresh_token blanked (see the
                # comment above this block — an unlocked self-refresh outside
                # /api/oauth/refresh-locks can revoke the whole token family
                # for a *pool* credential the runner rotates). A standalone
                # container-provided CODEX_OAUTH is single-slot/non-pool and
                # never gets a per-task overwrite from the runner, so
                # blanking its refresh token here would permanently strip the
                # only copy — leaving the Codex CLI unable to renew an
                # expired access token for the lifetime of the container.
                # Preserve it on the standalone path. Read via jq's `env`
                # builtin (rather than --argjson) so the invocation below
                # keeps its plain, unadorned shape — extractCodexOauthSeedFilter
                # in src/tests/entrypoint-codex-oauth-seed.test.ts locates this
                # program by anchoring on that exact prefix and re-runs it
                # against real jq.
                export CODEX_OAUTH_SEED_STANDALONE
                if ! echo "$CODEX_OAUTH_SEED" | jq '
                    (env.CODEX_OAUTH_SEED_STANDALONE == "true") as $standalone |
                    if .auth_mode == "chatgpt" then
                      (if $standalone then . else .tokens.refresh_token = "" end)
                    elif (.access and .refresh and .accountId and .expires) then
                      {
                        auth_mode: "chatgpt",
                        OPENAI_API_KEY: null,
                        tokens: {
                          id_token: .access,
                          access_token: .access,
                          refresh_token: (if $standalone then (.refresh // "") else "" end),
                          account_id: .accountId
                        },
                        last_refresh: ((.expires / 1000 | floor) | todateiso8601)
                      }
                    else
                      error("codex_oauth value is neither auth.json format nor flat credential format")
                    end
                ' > "$WORKER_CODEX_HOME/auth.json"; then
                    echo "Warning: codex_oauth source could not be converted to auth.json, skipping" >&2
                    rm -f "$WORKER_CODEX_HOME/auth.json"
                else
                chown worker:worker "$WORKER_CODEX_HOME/auth.json" 2>/dev/null || true
                chmod 600 "$WORKER_CODEX_HOME/auth.json"
                echo "[entrypoint] Seeded codex OAuth credentials (slot 0)"
                fi
            fi
        fi
    fi

    # Auth path 2: Fallback — bootstrap an api-key auth.json from OPENAI_API_KEY
    # when no codex_oauth is configured (or the restore above failed).
    if [ -n "${OPENAI_API_KEY:-}" ] && [ ! -f "$WORKER_CODEX_HOME/auth.json" ]; then
        mkdir -p "$WORKER_CODEX_HOME"
        chown -R worker:worker "$WORKER_CODEX_HOME" 2>/dev/null || true
        if gosu worker bash -c 'printenv OPENAI_API_KEY | codex login --with-api-key' >/dev/null 2>&1; then
            echo "Codex: registered OPENAI_API_KEY via 'codex login --with-api-key'"
        else
            echo "Warning: 'codex login --with-api-key' failed; worker may fail at first turn" >&2
        fi
    fi

    # Soft-check; TS-level loop will block until auth.json materialises.
    if [ ! -f "$WORKER_CODEX_HOME/auth.json" ]; then
        echo "Warning: codex provider has no auth.json yet (no OPENAI_API_KEY, no codex_oauth in config store, no pre-existing ~/.codex/auth.json). Worker will park in credential-wait until creds appear in swarm_config."
    fi
else
    # Claude auth (default) — soft check; TS-level loop blocks if missing.
    if [ -z "$CLAUDE_CODE_OAUTH_TOKEN" ] && [ -z "$ANTHROPIC_API_KEY" ]; then
        echo "Warning: claude provider has no credentials yet (CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY). Worker will park in credential-wait until creds appear in swarm_config."
    fi
fi

# ---- Verify provider binary is reachable ----
if [ "$HARNESS_PROVIDER" = "codex" ]; then
    CODEX_BIN="${CODEX_BINARY:-codex}"
    if ! command -v "$CODEX_BIN" > /dev/null 2>&1; then
        echo "FATAL: Codex CLI not found: '$CODEX_BIN'"
        echo "  PATH=$PATH"
        exit 1
    fi
    echo "Codex CLI: $(command -v "$CODEX_BIN")"
elif [ "$HARNESS_PROVIDER" = "claude-managed" ]; then
    # Cloud sandbox — no local CLI binary, no skills FS, no MCP discovery.
    echo "Claude Managed Agents: no local CLI required (sessions run in Anthropic cloud)"
elif [ "$HARNESS_PROVIDER" = "devin" ]; then
    echo "Devin: cloud API (no local binary required)"
elif [ "$HARNESS_PROVIDER" = "opencode" ]; then
    OPENCODE_BIN="${OPENCODE_BINARY:-opencode}"
    if ! command -v "$OPENCODE_BIN" > /dev/null 2>&1; then
        echo "FATAL: opencode CLI not found: '$OPENCODE_BIN'"
        echo "  PATH=$PATH"
        exit 1
    fi
    echo "opencode CLI: $(command -v "$OPENCODE_BIN")"
elif [ "$HARNESS_PROVIDER" != "pi" ]; then
    CLAUDE_BIN="${CLAUDE_BINARY:-claude}"
    # CLAUDE_BINARY may be a whitespace-separated command string. Only
    # the first token is the executable on PATH; the rest are argv.
    # Mirrors parseClaudeBinary in src/providers/claude-adapter.ts.
    CLAUDE_BIN_EXEC=$(echo "$CLAUDE_BIN" | awk '{print $1}')
    if ! command -v "$CLAUDE_BIN_EXEC" > /dev/null 2>&1; then
        echo "FATAL: Claude CLI not found: '$CLAUDE_BIN_EXEC' (from CLAUDE_BINARY='$CLAUDE_BIN')"
        echo "  PATH=$PATH"
        for loc in /usr/local/bin/claude /usr/bin/claude; do
            if [ -f "$loc" ]; then
                echo "  Found at $loc (not in PATH) — set CLAUDE_BINARY=$loc"
            fi
        done
        exit 1
    fi
    echo "Claude CLI: $(command -v "$CLAUDE_BIN_EXEC") (CLAUDE_BINARY='$CLAUDE_BIN')"
fi

# ---- Git safe.directory backstop ----
# Avoid "dubious ownership" when /workspace dirs are owned by a different uid
# (root-owned auto-clone, host-mounted volumes, etc.).
# --system writes to /etc/gitconfig and applies to ALL users, so the worker
# user inherits this after the gosu drop below.
git config --system --add safe.directory '*' 2>/dev/null || true

# Create personal workspace subdirectories.
# NOTE: Shared disk subdirectories are created per-agent below (see
# "Setting up per-agent directories" block), NOT here.
mkdir -p /workspace/personal/memory 2>/dev/null || true
# chown individual dirs (not -R) to avoid EPERM on mount-managed system files
chown worker:worker /workspace/personal 2>/dev/null || true
chown worker:worker /workspace/personal/memory 2>/dev/null || true

# ROLE and MCP_URL are resolved earlier (see the API readiness gate above),
# before any provider-specific block can read the control-plane API.

# Get version from compiled binary (extract just the version number)
VERSION=$(/usr/local/bin/agent-swarm version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo "unknown")

# Determine YOLO mode based on role
if [ "$ROLE" = "lead" ]; then
    YOLO_MODE="${LEAD_YOLO:-false}"
else
    YOLO_MODE="${WORKER_YOLO:-false}"
fi

echo "=== Agent Swarm ${ROLE^} v${VERSION} ==="
echo "Agent ID: ${AGENT_ID:-<not set>}"
echo "Harness Provider: $HARNESS_PROVIDER"
echo "MCP Base URL: $MCP_URL"
echo "YOLO Mode: $YOLO_MODE"
echo "Session ID: ${SESSION_ID:-<auto-generated>}"
echo "Working Directory: /workspace"
echo "[entrypoint] Claude Code auto-updater disabled: DISABLE_AUTOUPDATER=${DISABLE_AUTOUPDATER:-<unset>} (version: $(claude --version 2>/dev/null || echo unavailable))"
echo "=========================="

# Initialize PM2 daemon for background service management
echo ""
echo "=== PM2 Initialization ==="
echo "PM2 Home: ${PM2_HOME:-~/.pm2}"
# Ensure PM2 home directory exists (for persistence in /workspace)
mkdir -p "${PM2_HOME:-$HOME/.pm2}"
pm2 startup > /dev/null 2>&1 || true

# Restore services from ecosystem (database-driven, more reliable than pm2 resurrect)
ECOSYSTEM_FILE="/workspace/ecosystem.config.js"
if [ -n "$AGENT_ID" ]; then
    echo "Fetching ecosystem config from MCP server..."
    if curl -s -f -H "Authorization: Bearer ${API_KEY}" \
       -H "X-Agent-ID: ${AGENT_ID}" \
       "${MCP_URL}/ecosystem" > /tmp/ecosystem.json 2>/dev/null; then

        # Check if there are any apps to start
        APP_COUNT=$(cat /tmp/ecosystem.json | jq -r '.apps | length' 2>/dev/null || echo "0")

        if [ "$APP_COUNT" -gt "0" ]; then
            echo "Found $APP_COUNT registered service(s)"
            # Convert JSON to JS module
            echo "module.exports = $(cat /tmp/ecosystem.json);" > "$ECOSYSTEM_FILE"
            echo "Starting services from ecosystem file..."
            pm2 start "$ECOSYSTEM_FILE" || true
            pm2 list
        else
            echo "No services registered for this agent"
        fi
        rm -f /tmp/ecosystem.json
    else
        echo "Could not fetch ecosystem config (MCP server may be unavailable)"
    fi
else
    echo "AGENT_ID not set, skipping ecosystem restore"
fi

# Fallback: try pm2 resurrect for any locally saved processes
if pm2 resurrect 2>/dev/null; then
    pm2 list 2>/dev/null || true
fi
echo "=========================="

# Cleanup function for graceful shutdown
cleanup() {
    echo ""
    echo "Shutting down PM2 processes..."
    pm2 kill 2>/dev/null || true
}
trap cleanup EXIT SIGINT SIGTERM

# ---- Fetch swarm config from API ----
if [ -n "$AGENT_ID" ]; then
    echo "Fetching swarm config from API..."
    if curl -s -f -H "Authorization: Bearer ${API_KEY}" \
       -H "X-Agent-ID: ${AGENT_ID}" \
       "${MCP_URL}/api/config/resolved?agentId=${AGENT_ID}&includeSecrets=true" \
       > /tmp/swarm_config.json 2>/dev/null; then

        CONFIG_COUNT=$(jq '.configs | length' /tmp/swarm_config.json 2>/dev/null || echo "0")
        if [ "$CONFIG_COUNT" -gt 0 ]; then
            echo "Found $CONFIG_COUNT config entries, exporting as env vars..."
            # Skip keys whose value is read dynamically by the runner from
            # /api/config/resolved on each iteration. Baking them into env at
            # boot would persist a stale value if the operator later deletes
            # the swarm_config row (env would shadow the now-missing config).
            #   - codex_oauth: provider auth blob, read on demand
            #   - HARNESS_PROVIDER: live-reconciled by runner.ts poll loop;
            #     baking it would also defeat the precedence invariant
            #     (swarm_config > env > "claude")
            # Also skip keys that are not valid POSIX shell identifiers
            # (e.g. CF-Access-Client-Id). Sourcing such a key causes the shell
            # to parse "CF-Access-Client-Id=value" as a command invocation →
            # "command not found", aborting the rest of the export. These keys
            # are still available to the runner via headerConfigKeys (resolved
            # per-request), so skipping them here is safe.
            SKIPPED_NONIDENT=$(jq -r '.configs[] | select(.key != "codex_oauth" and .key != "HARNESS_PROVIDER") | select(.key | test("^[A-Za-z_][A-Za-z0-9_]*$") | not) | .key' /tmp/swarm_config.json 2>/dev/null || true)
            if [ -n "$SKIPPED_NONIDENT" ]; then
                echo "[entrypoint] debug: skipping non-identifier config keys (not valid POSIX shell variable names, still available via headerConfigKeys): $(echo "$SKIPPED_NONIDENT" | tr '\n' ' ')"
            fi
            jq -r '.configs[] | select(.key != "codex_oauth" and .key != "HARNESS_PROVIDER") | select(.key | test("^[A-Za-z_][A-Za-z0-9_]*$")) | "\(.key)=" + (.value | @sh)' /tmp/swarm_config.json > /tmp/swarm_config.env 2>/dev/null || true
            if [ -f /tmp/swarm_config.env ]; then
                set -a
                . /tmp/swarm_config.env
                set +a
                rm -f /tmp/swarm_config.env
            fi
        fi
        rm -f /tmp/swarm_config.json
    else
        echo "Warning: Could not fetch swarm config (API may not be ready)"
    fi
fi
# ---- End swarm config fetch ----

# agent-fs credentials are provisioned by the API-owned runner endpoint
# (`POST /api/fs/agent-credentials`) so workers never need the shared bootstrap
# key and never write credential rows directly from shell startup.

# Create .mcp.json in /workspace (project-level config).
# Skip for claude-managed: managed agents read MCP servers from the Agent
# definition (set by claude-managed-setup), not from a local filesystem file.
if [ "$HARNESS_PROVIDER" = "claude-managed" ]; then
    echo "Skipping local .mcp.json (claude-managed reads MCP from agent definition)"
else
echo "Creating MCP config in /workspace..."
# Build base MCP config with jq
MCP_JSON=$(jq -n \
  --arg url "${MCP_URL}/mcp" \
  --arg apiKey "Bearer ${API_KEY}" \
  '{mcpServers: {"agent-swarm": {type: "http", url: $url, headers: {Authorization: $apiKey}}}}')

# Add X-Agent-ID header if set
if [ -n "$AGENT_ID" ]; then
    MCP_JSON=$(echo "$MCP_JSON" | jq --arg agentId "$AGENT_ID" \
      '.mcpServers["agent-swarm"].headers["X-Agent-ID"] = $agentId')
fi

# Add agentmail-mcp if API key is present
if [ -n "$AGENTMAIL_API_KEY" ]; then
    MCP_JSON=$(echo "$MCP_JSON" | jq --arg key "$AGENTMAIL_API_KEY" \
      '.mcpServers.agentmail = {command: "npx", args: ["-y", "agentmail-mcp"], env: {AGENTMAIL_API_KEY: $key}}')
fi

# === Installed MCP servers (from API) ===
# NOTE (issue #369): we intentionally do NOT bake resolved credentials (OAuth Bearers,
# env secrets, static headers) into /workspace/.mcp.json. The per-session dispatcher
# in src/providers/claude-adapter.ts re-fetches the installed server list on every
# session start and injects fresh credentials into a per-session MCP config via
# --mcp-config + --strict-mcp-config. Baking credentials here made OAuth re-auth,
# secret rotation, and install/uninstall silently fail to propagate until the
# worker was restarted. We still fetch the list at startup so we can pre-register
# permission patterns (mcp__<name>__*) in settings.json — that is not secret.
MCP_SERVERS_RESPONSE=""
SERVER_COUNT=0
if [ -n "$AGENT_ID" ] && [ -n "$API_KEY" ]; then
  echo "Fetching installed MCP server names (for permission patterns only)..."
  # resolveSecrets=false: we only need names at entrypoint time; credentials are
  # resolved per-session by the dispatcher.
  MCP_SERVERS_RESPONSE=$(curl -sf -H "Authorization: Bearer $API_KEY" \
    "${MCP_URL}/api/agents/${AGENT_ID}/mcp-servers?resolveSecrets=false" 2>/dev/null) || true

  if [ -n "$MCP_SERVERS_RESPONSE" ]; then
    SERVER_COUNT=$(echo "$MCP_SERVERS_RESPONSE" | jq '.servers | length' 2>/dev/null || echo "0")
    if [ "$SERVER_COUNT" -gt 0 ]; then
      echo "Found $SERVER_COUNT installed MCP server(s) — will be injected per-session, not baked into .mcp.json"
    fi
  fi
fi

echo "$MCP_JSON" > /workspace/.mcp.json

# === Update settings.json with MCP server permissions ===
if [ -n "$MCP_SERVERS_RESPONSE" ] && [ "$SERVER_COUNT" -gt 0 ]; then
  SETTINGS_FILE="$HOME/.claude/settings.json"
  if [ -f "$SETTINGS_FILE" ]; then
    echo "Adding MCP server permission patterns to settings.json"
    UPDATED_SETTINGS=$(echo "$MCP_SERVERS_RESPONSE" | jq --slurpfile settings "$SETTINGS_FILE" '
      [.servers[].name] |
      map("mcp__" + . + "__*") |
      . as $new_perms |
      $settings[0] |
      .permissions.allow = (.permissions.allow + $new_perms | unique)
    ')
    echo "$UPDATED_SETTINGS" > "$SETTINGS_FILE"
  fi
fi
fi  # /HARNESS_PROVIDER != claude-managed (MCP discovery skip)

# Configure GitHub authentication if token is provided
echo ""
echo "=== GitHub Authentication ==="
if [ -n "$GITHUB_TOKEN" ]; then
    echo "Configuring GitHub authentication..."

    # gh CLI will automatically use GITHUB_TOKEN env var for API calls
    # Just need to configure git to use gh as credential helper
    gh auth setup-git

    # Set git user config for commits (use env vars or defaults)
    GIT_EMAIL="${GITHUB_EMAIL:-worker-agent@desplega.ai}"
    GIT_NAME="${GITHUB_NAME:-Worker Agent}"
    git config --global user.email "$GIT_EMAIL"
    git config --global user.name "$GIT_NAME"

    # Pin the identity at the environment level so repo-local config and
    # session-level `git config` writes cannot change commit identity.
    export GIT_AUTHOR_NAME="$GIT_NAME"
    export GIT_AUTHOR_EMAIL="$GIT_EMAIL"
    export GIT_COMMITTER_NAME="$GIT_NAME"
    export GIT_COMMITTER_EMAIL="$GIT_EMAIL"

    echo "GitHub authentication configured successfully"
    echo "Git user: $GIT_NAME <$GIT_EMAIL>"
else
    echo "WARNING: GITHUB_TOKEN not set - GitHub git push operations will fail"
fi
echo "=============================="

# Configure GitLab authentication if token is provided
echo ""
echo "=== GitLab Authentication ==="
if [ -n "$GITLAB_TOKEN" ] && ! command -v glab > /dev/null 2>&1; then
    echo "WARNING: GITLAB_TOKEN set but glab is not installed (slim image?) - GitLab integration disabled"
elif [ -n "$GITLAB_TOKEN" ]; then
    echo "Configuring GitLab authentication..."

    # Configure glab CLI with the token
    GITLAB_HOST="${GITLAB_URL:-https://gitlab.com}"
    # Strip protocol for glab host config
    GITLAB_HOST_BARE=$(echo "$GITLAB_HOST" | sed 's|https\?://||')
    echo "$GITLAB_TOKEN" | glab auth login --hostname "$GITLAB_HOST_BARE" --stdin 2>/dev/null || true

    # Set git user config for GitLab commits (use GitLab-specific env vars or fall back to GitHub ones)
    GITLAB_GIT_EMAIL="${GITLAB_EMAIL:-${GITHUB_EMAIL:-worker-agent@desplega.ai}}"
    GITLAB_GIT_NAME="${GITLAB_NAME:-${GITHUB_NAME:-Worker Agent}}"
    # Only override git config if GitHub didn't set it already
    if [ -z "$GITHUB_TOKEN" ]; then
        git config --global user.email "$GITLAB_GIT_EMAIL"
        git config --global user.name "$GITLAB_GIT_NAME"
        export GIT_AUTHOR_NAME="$GITLAB_GIT_NAME"
        export GIT_AUTHOR_EMAIL="$GITLAB_GIT_EMAIL"
        export GIT_COMMITTER_NAME="$GITLAB_GIT_NAME"
        export GIT_COMMITTER_EMAIL="$GITLAB_GIT_EMAIL"
    fi

    echo "GitLab authentication configured successfully (host: $GITLAB_HOST_BARE)"
else
    echo "GITLAB_TOKEN not set - GitLab integration disabled for this worker"
fi
echo "=============================="

# ---- Auto-clone registered repos ----
echo ""
echo "=== Repo Auto-Clone ==="
if [ -n "$AGENT_ID" ]; then
    echo "Fetching registered repos from API..."
    if curl -s -f -H "Authorization: Bearer ${API_KEY}" \
       -H "X-Agent-ID: ${AGENT_ID}" \
       "${MCP_URL}/api/repos?autoClone=true" \
       > /tmp/swarm_repos.json 2>/dev/null; then

        REPO_COUNT=$(jq '.repos | length' /tmp/swarm_repos.json 2>/dev/null || echo "0")
        if [ "$REPO_COUNT" -gt 0 ]; then
            echo "Found $REPO_COUNT repos to clone..."

            jq -c '.repos[]' /tmp/swarm_repos.json | while read -r repo; do
                REPO_URL=$(echo "$repo" | jq -r '.url')
                REPO_NAME=$(echo "$repo" | jq -r '.name')
                REPO_BRANCH=$(echo "$repo" | jq -r '.defaultBranch // "main"')
                REPO_DIR=$(echo "$repo" | jq -r '.clonePath')
                REPO_HOOKS_ENABLED=$(echo "$repo" | jq -r '.hooks.enabled // false')

                # Ensure parent directory exists and is owned by worker so the
                # gosu-dropped clone/pull below can write into it. Lenient chown
                # mirrors the pattern used for /workspace/personal subdirs above.
                mkdir -p "$(dirname "$REPO_DIR")"
                chown worker:worker "$(dirname "$REPO_DIR")" 2>/dev/null || true

                # Run clone/pull as the worker user so .git ends up worker-owned
                # — otherwise the runner (post-gosu) hits "dubious ownership".
                # gosu inherits env, so GH_TOKEN/GITHUB_TOKEN propagate to gh.
                if [ -d "${REPO_DIR}/.git" ]; then
                    echo "  Syncing ${REPO_NAME} (${REPO_BRANCH}) at ${REPO_DIR}..."
                    # Auto-cloned default branches are disposable tracking checkouts.
                    # Keep feature branches and dirty worktrees untouched; clean default
                    # branches are reset to origin so local swarm-autostash commits do
                    # not permanently block startup updates.
                    gosu worker bash -c "cd '$REPO_DIR' && \
                        CURRENT_BRANCH=\$(git branch --show-current) && \
                        if [ \"\$CURRENT_BRANCH\" != '$REPO_BRANCH' ]; then \
                            echo '    Skipping sync: checked out on' \"\$CURRENT_BRANCH\"; \
                            exit 0; \
                        fi && \
                        if ! git diff --quiet || ! git diff --cached --quiet; then \
                            echo '    Skipping sync: worktree has local changes'; \
                            exit 0; \
                        fi && \
                        git fetch origin '$REPO_BRANCH' --prune && \
                        git reset --hard 'origin/$REPO_BRANCH'" || echo "  Warning: Could not sync ${REPO_NAME}"
                else
                    echo "  Cloning ${REPO_NAME} to ${REPO_DIR} (branch: ${REPO_BRANCH})..."
                    gosu worker bash -c "gh repo clone '$REPO_URL' '$REPO_DIR' -- --branch '$REPO_BRANCH' --single-branch" || echo "  Warning: Could not clone ${REPO_NAME}"
                fi

                if [ "$REPO_HOOKS_ENABLED" = "true" ] && [ -d "${REPO_DIR}/.git" ]; then
                    gosu worker /usr/local/bin/install-repo-hooks.sh "$REPO_DIR" "$REPO_NAME" || echo "  Warning: Could not install git hooks for ${REPO_NAME}"
                fi
            done
        else
            echo "No repos registered for auto-clone"
        fi
        rm -f /tmp/swarm_repos.json
    else
        echo "Warning: Could not fetch repos (API may not be ready)"
    fi
else
    echo "Skipping repo clone (no AGENT_ID)"
fi
echo "==============================="


# Find existing startup script in /workspace (start-up.sh, .bash, .js, .ts, .bun, or bare)
find_startup_script() {
    for pattern in start-up.sh start-up.bash start-up.js start-up.ts start-up.bun start-up; do
        if [ -f "/workspace/${pattern}" ]; then
            echo "/workspace/${pattern}"
            return 0
        fi
    done
    return 1
}


# ---- Fetch and compose setup scripts from API ----
if [ -n "$AGENT_ID" ]; then
    echo ""
    echo "=== Setup Script Fetch ==="
    echo "Fetching setup scripts from API..."
    if curl -s -f -H "Authorization: Bearer ${API_KEY}" \
       -H "X-Agent-ID: ${AGENT_ID}" \
       "${MCP_URL}/api/agents/${AGENT_ID}/setup-script" \
       > /tmp/setup_scripts.json 2>/dev/null; then

        GLOBAL_SCRIPT=$(jq -r '.globalSetupScript // empty' /tmp/setup_scripts.json 2>/dev/null)
        AGENT_SCRIPT=$(jq -r '.setupScript // empty' /tmp/setup_scripts.json 2>/dev/null)

        if [ -n "$GLOBAL_SCRIPT" ]; then
            echo "Executing global setup script as root..."
            GLOBAL_TEMP_FILE=$(mktemp)
            echo "#!/bin/bash" > "$GLOBAL_TEMP_FILE"
            echo "$GLOBAL_SCRIPT" >> "$GLOBAL_TEMP_FILE"
            chmod +x "$GLOBAL_TEMP_FILE"
            GLOBAL_EXIT_CODE=0
            "$GLOBAL_TEMP_FILE" || GLOBAL_EXIT_CODE=$?
            rm -f "$GLOBAL_TEMP_FILE"
            if [ "$GLOBAL_EXIT_CODE" -ne 0 ]; then
                echo ""
                echo "ERROR: Global setup script failed with exit code $GLOBAL_EXIT_CODE"
                if [ "${STARTUP_SCRIPT_STRICT:-false}" = "true" ]; then
                    echo "STARTUP_SCRIPT_STRICT=true - Exiting..."
                    exit "$GLOBAL_EXIT_CODE"
                else
                    echo "STARTUP_SCRIPT_STRICT=false - Continuing despite global setup error..."
                fi
            fi
        fi

        if [ -n "$GLOBAL_SCRIPT" ] || [ -n "$AGENT_SCRIPT" ]; then
            EXISTING_STARTUP=$(find_startup_script) || true

            if [ -n "$EXISTING_STARTUP" ]; then
                # Prepend to existing file (preserve operator content)
                echo "Prepending agent setup script to existing ${EXISTING_STARTUP}..."
                TEMP_FILE=$(mktemp)
                echo "#!/bin/bash" > "$TEMP_FILE"
                # Agent script goes between markers (synced back to DB by hooks).
                # Global setup is executed separately as root above and must not
                # be included in the worker-executed startup file.
                if [ -n "$AGENT_SCRIPT" ]; then
                    echo "# === Agent-managed setup (from DB) ===" >> "$TEMP_FILE"
                    echo "$AGENT_SCRIPT" >> "$TEMP_FILE"
                    echo "# === End agent-managed setup ===" >> "$TEMP_FILE"
                fi
                echo "" >> "$TEMP_FILE"
                # Strip shebang, global section, and existing marker sections from original
                sed '1{/^#!/d;}' "$EXISTING_STARTUP" \
                    | sed '/^# --- Global setup script ---$/,/^$/d' \
                    | sed '/^# === Agent-managed setup (from DB) ===$/,/^# === End agent-managed setup ===$/d' \
                    >> "$TEMP_FILE"
                mv "$TEMP_FILE" "$EXISTING_STARTUP"
                chmod +x "$EXISTING_STARTUP"
            elif [ -n "$AGENT_SCRIPT" ]; then
                # Create new start-up.sh
                echo "Creating /workspace/start-up.sh from agent setup script..."
                echo "#!/bin/bash" > /workspace/start-up.sh
                echo "# === Agent-managed setup (from DB) ===" >> /workspace/start-up.sh
                echo "$AGENT_SCRIPT" >> /workspace/start-up.sh
                echo "# === End agent-managed setup ===" >> /workspace/start-up.sh
                chmod +x /workspace/start-up.sh
            fi
            echo "Setup scripts prepared (global root hook: $([ -n "$GLOBAL_SCRIPT" ] && echo "yes" || echo "no"), agent worker hook: $([ -n "$AGENT_SCRIPT" ] && echo "yes" || echo "no"))"
        else
            echo "No setup scripts configured"
        fi
        rm -f /tmp/setup_scripts.json
    else
        echo "Warning: Could not fetch setup scripts (API may not be ready)"
    fi
    echo "==============================="
fi
# ---- End setup script fetch ----


echo ""
echo "=== Workspace Initialization ==="

# Create todos.md if it doesn't exist
PERSONAL_DIR="/workspace/personal"
if [ ! -f "$PERSONAL_DIR/todos.md" ]; then
    echo "Creating personal todos.md..."
    cat > "$PERSONAL_DIR/todos.md" << EOF || echo "Warning: Could not create todos.md (disk may not be mounted)"
# My TODOs

## Current
- [ ] <task here>
EOF
else
    echo "Personal todo.md already exists, skipping creation"
fi

# Set up per-agent directories on the shared disk (requires AGENT_ID at runtime)
# Each agent gets exclusive write access to its own subdirectories under each
# category (thoughts, memory, downloads, misc). All agents can read everything
# via the --shared mount.
if [ -n "$AGENT_ID" ]; then
    AGENT_SHARED="/workspace/shared"

    echo "Setting up per-agent directories for $AGENT_ID..."

    for category in "thoughts" "memory" "downloads" "misc"; do
        AGENT_DIR="$AGENT_SHARED/$category/$AGENT_ID"

        # Create our subdir. Entrypoint runs as root, so no sudo needed.
        mkdir -p "$AGENT_DIR" 2>/dev/null || true

        chown worker:worker "$AGENT_DIR" 2>/dev/null || true
    done

    # Create standard subdirectories (within owned dirs, always succeeds)
    mkdir -p "$AGENT_SHARED/thoughts/$AGENT_ID/plans"
    mkdir -p "$AGENT_SHARED/thoughts/$AGENT_ID/research"
    mkdir -p "$AGENT_SHARED/thoughts/$AGENT_ID/brainstorms"
    mkdir -p "$AGENT_SHARED/downloads/$AGENT_ID/slack"

    echo "Per-agent directories ready for $AGENT_ID"
fi

echo "==============================="
echo ""

# --- Skill sync ---
echo "=== Skill Sync ==="
if [ "$HARNESS_PROVIDER" = "claude-managed" ]; then
    # Managed agents read skills from the Agent definition (uploaded via API
    # by claude-managed-setup), NOT from the local filesystem. Skip the sync.
    echo "[entrypoint] Skipping skill sync (claude-managed reads skills from agent definition)"
elif [ -n "$AGENT_ID" ] && [ -n "$API_KEY" ] && [ -n "$MCP_BASE_URL" ]; then
    echo "[entrypoint] Syncing skills to filesystem..."
    SKILLS_RESPONSE=$(curl -s -f -H "Authorization: Bearer ${API_KEY}" \
        -H "X-Agent-ID: ${AGENT_ID}" \
        "${MCP_BASE_URL}/api/agents/${AGENT_ID}/skills" 2>/dev/null) || true

    if [ -n "$SKILLS_RESPONSE" ]; then
        # Write simple skills to ~/.claude/skills/ and ~/.pi/agent/skills/
        echo "$SKILLS_RESPONSE" | jq -r '.skills[] | select(.isComplex == false) | select(.content != "") | @base64' 2>/dev/null | while read -r skill_b64; do
            SKILL_NAME=$(echo "$skill_b64" | base64 -d | jq -r '.name')
            SKILL_CONTENT=$(echo "$skill_b64" | base64 -d | jq -r '.content')

            if [ -n "$SKILL_NAME" ] && [ "$SKILL_NAME" != "null" ]; then
                mkdir -p "$HOME/.claude/skills/$SKILL_NAME"
                echo "$SKILL_CONTENT" > "$HOME/.claude/skills/$SKILL_NAME/SKILL.md"

                mkdir -p "$HOME/.pi/agent/skills/$SKILL_NAME"
                cp "$HOME/.claude/skills/$SKILL_NAME/SKILL.md" "$HOME/.pi/agent/skills/$SKILL_NAME/SKILL.md"

                mkdir -p "$HOME/.codex/skills/$SKILL_NAME"
                cp "$HOME/.claude/skills/$SKILL_NAME/SKILL.md" "$HOME/.codex/skills/$SKILL_NAME/SKILL.md"
                echo "[entrypoint] Synced skill: $SKILL_NAME"
            fi
        done

        # Install legacy complex remote skills via npx. DB-backed complex skills
        # are synced through /api/skills/sync-filesystem; this remains a safe
        # fallback for sourceRepo-only skills.
        echo "$SKILLS_RESPONSE" | jq -r '.skills[] | select(.isComplex == true) | [.id, (.sourceRepo // "")] | @tsv' 2>/dev/null | while IFS=$'\t' read -r skill_id repo; do
            if [ -n "$repo" ]; then
                npx skills add "$repo" -a claude-code -a pi -a codex -g -y 2>&1 || echo "[entrypoint] Warning: failed to install complex skill from $repo" >&2
            else
                echo "[entrypoint] Warning: complex skill ${skill_id:-unknown} has no sourceRepo; skipping npx install" >&2
            fi
        done

        echo "[entrypoint] Skill sync complete"
    else
        echo "[entrypoint] No skills response from API (server may still be booting)"
    fi
else
    echo "[entrypoint] Skipping skill sync (missing AGENT_ID, API_KEY, or MCP_BASE_URL)"
fi

# Reclaim skill directories for the worker user. The entrypoint runs as root
# with HOME=/home/worker, so mkdir/cp above creates root-owned dirs. Without
# this chown the runner-side skill-fs-writer (running as worker) gets EACCES on
# every write attempt — ~165 errors per container per day.
chown -R worker:worker /home/worker/.claude/skills 2>/dev/null || true
chown -R worker:worker /home/worker/.pi/agent/skills 2>/dev/null || true
chown -R worker:worker /home/worker/.codex/skills 2>/dev/null || true
chown -R worker:worker /home/worker/.agents/skills 2>/dev/null || true

echo ""

# Reclaim /home/worker/.local for worker before dropping privileges.
# This entrypoint runs as root with HOME=/home/worker, so anything root wrote
# into .local would otherwise block worker-side mkdir into .local/share.
chown -R worker:worker /home/worker/.local 2>/dev/null || true

# Reclaim /home/worker/.claude for worker before dropping privileges.
# The harness runs `mkdir /home/worker/.claude/session-env/<session-id>` as the
# worker user before spawning each shell. If root wrote into .claude earlier in
# this entrypoint (settings.json, skills/) and left the tree root-owned, that
# mkdir fails with EACCES and NO shell ever starts — every task in the container
# dies at harness setup. Reclaiming the whole tree keeps session-env (and
# anything else the harness writes under .claude) writable by worker. The
# narrower .claude/skills chown above is now subsumed by this but is kept for
# documentation of the skill-fs-writer intent.
chown -R worker:worker /home/worker/.claude 2>/dev/null || true

# Optional: initialize a local PostgreSQL 16 cluster before dropping privileges.
# command -v guard: postgres/redis servers only ship in the full image — on the
# slim image these flags log a warning instead of killing the boot (set -e).
if [ "${SWARM_DEP_POSTGRES_ENABLED:-false}" = "true" ]; then
  if [ -x /usr/lib/postgresql/16/bin/initdb ]; then
    /usr/local/bin/init-local-postgres.sh
  else
    echo "WARNING: SWARM_DEP_POSTGRES_ENABLED=true but PostgreSQL is not installed (slim image?) - skipping"
  fi
fi

# Optional: start a local Redis server before dropping privileges.
if [ "${SWARM_DEP_REDIS_ENABLED:-false}" = "true" ]; then
  if command -v redis-server > /dev/null 2>&1; then
    /usr/local/bin/init-local-redis.sh
  else
    echo "WARNING: SWARM_DEP_REDIS_ENABLED=true but Redis is not installed (slim image?) - skipping"
  fi
fi

WORKER_BOOTSTRAP="/tmp/agent-swarm-worker-entrypoint.sh"
cat > "$WORKER_BOOTSTRAP" <<'EOF'
#!/bin/bash
set -e

find_startup_script() {
    for pattern in start-up.sh start-up.bash start-up.js start-up.ts start-up.bun start-up; do
        if [ -f "/workspace/${pattern}" ]; then
            echo "/workspace/${pattern}"
            return 0
        fi
    done
    return 1
}

run_startup_script() {
    local role="${AGENT_ROLE:-worker}"
    local startup_script_strict="${STARTUP_SCRIPT_STRICT:-false}"
    local startup_script=""
    local exit_code=0

    echo ""
    echo "=== Startup Script Detection (${role}) ==="

    startup_script=$(find_startup_script) || true

    if [ -z "$startup_script" ]; then
        echo "No startup script found (looked for /workspace/start-up.*)"
        echo "Skipping startup script execution"
        return 0
    fi

    echo "Found startup script: $startup_script"
    echo "Executing startup script as user: $(id -un) (uid $(id -u))"

    if [ ! -x "$startup_script" ]; then
        echo "Script is not executable, checking for shebang..."
    fi

    local first_line
    first_line=$(head -n 1 "$startup_script")

    if [[ "$first_line" =~ ^#! ]]; then
        local interpreter
        interpreter="${first_line#\#!}"
        interpreter=$(echo "$interpreter" | xargs)
        echo "Detected shebang interpreter: $interpreter"

        if [[ "$interpreter" =~ ^/usr/bin/env ]]; then
            local actual_interpreter
            actual_interpreter=$(echo "$interpreter" | awk '{print $2}')
            echo "Using env interpreter: $actual_interpreter"
            interpreter="$actual_interpreter"
        fi

        echo "Executing startup script with interpreter: $interpreter"
        $interpreter "$startup_script" || exit_code=$?
    else
        local extension
        extension="${startup_script##*.}"
        echo "No shebang found, inferring from extension: .$extension"

        case "$extension" in
            sh|bash)
                echo "Executing with bash..."
                bash "$startup_script" || exit_code=$?
                ;;
            js)
                echo "Executing with node..."
                node "$startup_script" || exit_code=$?
                ;;
            ts)
                echo "Executing with bun (TypeScript)..."
                bun run "$startup_script" || exit_code=$?
                ;;
            bun)
                echo "Executing with bun..."
                bun run "$startup_script" || exit_code=$?
                ;;
            *)
                if [ -x "$startup_script" ]; then
                    echo "Executing directly (executable bit set)..."
                    "$startup_script" || exit_code=$?
                else
                    echo "WARNING: Unknown extension and not executable, trying bash..."
                    bash "$startup_script" || exit_code=$?
                fi
                ;;
        esac
    fi

    if [ "$exit_code" -ne 0 ]; then
        echo ""
        echo "WARNING: Startup script failed with exit code $exit_code"
        echo "Per-agent setupScript / /workspace/start-up.* now runs as the unprivileged worker user since v1.106.0."
        echo "This was a security fix for the setupScript privilege boundary; passwordless sudo was also removed."
        echo "Move root-requiring steps to the global SETUP_SCRIPT config or into the worker image."
        echo "For user-level setup, prefer worker-owned installs such as 'bun i -g' or an npm prefix under \$HOME."
        echo "Set STARTUP_SCRIPT_STRICT=true to restore fail-fast startup-script behavior."

        if [ "$startup_script_strict" = "true" ]; then
            echo "STARTUP_SCRIPT_STRICT=true - Exiting..."
            exit "$exit_code"
        else
            echo "STARTUP_SCRIPT_STRICT=false - Continuing despite startup script error..."
        fi
    else
        echo "Startup script completed successfully"
    fi
}

run_startup_script

role="${AGENT_ROLE:-worker}"
echo "Starting $role..."
exec /usr/local/bin/agent-swarm "$role" "$@"
EOF
chmod 755 "$WORKER_BOOTSTRAP"
chown worker:worker "$WORKER_BOOTSTRAP" 2>/dev/null || true

# Run the agent using compiled binary.
#
# `tini` is prepended so PID 1 is a real init. The agent-swarm process spawns
# the harness (Claude/Codex/pi) as a direct child — which Bun reaps — but the
# harness in turn spawns grandchildren (npm, esbuild, headless chrome,
# next-server, ffmpeg, git ...) while running agent tasks. When a grandchild
# outlives its immediate parent it is reparented to PID 1. Without an init at
# PID 1, those orphans become unreaped zombies that accumulate for the life of
# the container (one per orphaned grandchild, unbounded over uptime). tini
# calls waitpid(-1) and reaps every orphan, and forwards signals to the worker.
exec tini -- gosu worker "$WORKER_BOOTSTRAP" "$@"
