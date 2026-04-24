#!/bin/bash
set -e

# Validate required environment variables based on provider
HARNESS_PROVIDER="${HARNESS_PROVIDER:-claude}"

if [ "$HARNESS_PROVIDER" = "pi" ]; then
    # Pi-mono auth: ANTHROPIC_API_KEY, OPENROUTER_API_KEY, or auth.json must exist
    if [ -z "$ANTHROPIC_API_KEY" ] && [ -z "$OPENROUTER_API_KEY" ] && [ ! -f "$HOME/.pi/agent/auth.json" ]; then
        echo "Error: ANTHROPIC_API_KEY, OPENROUTER_API_KEY, or ~/.pi/agent/auth.json required for pi provider"
        exit 1
    fi
elif [ "$HARNESS_PROVIDER" = "codex" ]; then
    WORKER_CODEX_HOME="/home/worker/.codex"

    # Auth path 1: OPENAI_API_KEY → bootstrap via codex login --with-api-key
    if [ -n "${OPENAI_API_KEY:-}" ] && [ ! -f "$WORKER_CODEX_HOME/auth.json" ]; then
        mkdir -p "$WORKER_CODEX_HOME"
        chown -R worker:worker "$WORKER_CODEX_HOME" 2>/dev/null || true
        if gosu worker bash -c 'printenv OPENAI_API_KEY | codex login --with-api-key' >/dev/null 2>&1; then
            echo "Codex: registered OPENAI_API_KEY via 'codex login --with-api-key'"
        else
            echo "Warning: 'codex login --with-api-key' failed; worker may fail at first turn" >&2
        fi
    fi

    # Auth path 2: Restore codex_oauth from config store
    if [ ! -f "$WORKER_CODEX_HOME/auth.json" ] && [ -n "$API_KEY" ] && [ -n "$MCP_BASE_URL" ]; then
        CODEX_OAUTH=$(curl -sf -H "Authorization: Bearer ${API_KEY}" \
            "${MCP_BASE_URL}/api/config/resolved?includeSecrets=true&key=codex_oauth" \
            2>/dev/null | jq -r '.configs[] | select(.key == "codex_oauth") | .value // empty' 2>/dev/null | head -1)
        if [ -n "$CODEX_OAUTH" ]; then
            if ! echo "$CODEX_OAUTH" | jq '.' >/dev/null 2>&1; then
                echo "Warning: codex_oauth from config store is not valid JSON, skipping" >&2
            else
                mkdir -p "$WORKER_CODEX_HOME"
                if ! echo "$CODEX_OAUTH" | jq '
                    if .auth_mode == "chatgpt" then
                      .
                    elif (.access and .refresh and .accountId and .expires) then
                      {
                        auth_mode: "chatgpt",
                        OPENAI_API_KEY: null,
                        tokens: {
                          id_token: .access,
                          access_token: .access,
                          refresh_token: .refresh,
                          account_id: .accountId
                        },
                        last_refresh: ((.expires / 1000 | floor) | todateiso8601)
                      }
                    else
                      error("codex_oauth value is neither auth.json format nor flat credential format")
                    end
                ' > "$WORKER_CODEX_HOME/auth.json"; then
                    echo "Warning: codex_oauth from config store could not be converted to auth.json, skipping" >&2
                    rm -f "$WORKER_CODEX_HOME/auth.json"
                else
                chown worker:worker "$WORKER_CODEX_HOME/auth.json" 2>/dev/null || true
                chmod 600 "$WORKER_CODEX_HOME/auth.json"
                echo "[entrypoint] Restored codex OAuth credentials from API config store"
                fi
            fi
        fi
    fi

    # Fail if still no auth
    if [ ! -f "$WORKER_CODEX_HOME/auth.json" ]; then
        echo "Error: codex provider requires OPENAI_API_KEY, ~/.codex/auth.json, or codex_oauth in config store"
        exit 1
    fi
else
    # Claude auth (default)
    # Allow both Oauth and ANTHROPIC_API_KEY for flexibility, but require at least one
    if [ -z "$CLAUDE_CODE_OAUTH_TOKEN" ] && [ -z "$ANTHROPIC_API_KEY" ]; then
        echo "Error: Claude provider requires either CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY environment variable"
        exit 1
    fi
fi

if [ -z "$API_KEY" ]; then
    echo "Error: API_KEY environment variable is required"
    exit 1
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
elif [ "$HARNESS_PROVIDER" != "pi" ]; then
    CLAUDE_BIN="${CLAUDE_BINARY:-claude}"
    if ! command -v "$CLAUDE_BIN" > /dev/null 2>&1; then
        echo "FATAL: Claude CLI not found: '$CLAUDE_BIN'"
        echo "  PATH=$PATH"
        for loc in /usr/local/bin/claude /usr/bin/claude; do
            if [ -f "$loc" ]; then
                echo "  Found at $loc (not in PATH) — set CLAUDE_BINARY=$loc"
            fi
        done
        exit 1
    fi
    echo "Claude CLI: $(command -v "$CLAUDE_BIN")"
fi

# ---- Archil disk mounts ----
# Skipped when ARCHIL_MOUNT_TOKEN is not set (local dev / environments without Archil)
if [ -n "$ARCHIL_MOUNT_TOKEN" ]; then
    echo ""
    echo "=== Archil Mount ==="

    # Ensure /dev/fuse exists (needed in some VM environments like Fly.io Firecracker)
    if [ ! -e /dev/fuse ]; then
        mknod /dev/fuse c 10 229
        chmod 666 /dev/fuse
    fi

    if [ -n "$ARCHIL_SHARED_DISK_NAME" ]; then
        echo "Mounting shared disk ($ARCHIL_SHARED_DISK_NAME) at /workspace/shared..."
        archil mount --shared "$ARCHIL_SHARED_DISK_NAME" /workspace/shared --region "$ARCHIL_REGION"
    fi

    # NOTE: Top-level shared directory pre-creation (thoughts/, memory/, etc.)
    # lives in api-entrypoint.sh, not here. The API boots first and creates
    # them so workers' mkdir auto-grants delegation at the subdir level.

    if [ -n "$ARCHIL_PERSONAL_DISK_NAME" ]; then
        echo "Mounting personal disk ($ARCHIL_PERSONAL_DISK_NAME) at /workspace/personal..."
        # --force reclaims stale delegations from previous machine incarnations.
        # Personal disks are always single-client, so force is safe.
        # archil mount requires root — entrypoint runs as root (USER root in Dockerfile).
        archil mount --force "$ARCHIL_PERSONAL_DISK_NAME" /workspace/personal --region "$ARCHIL_REGION"
        # Brief pause for FUSE daemon to finish --force re-negotiation
        sleep 1
    fi
    echo "===================="
fi
# ---- End Archil mount ----

# Create personal workspace subdirectories (after FUSE mount, since Archil
# requires empty mount points — these dirs can't exist at build time).
# Personal disk is exclusive (rw), so this always succeeds.
# NOTE: Shared disk subdirectories are created per-agent below (see
# "Setting up per-agent directories" block), NOT here.
mkdir -p /workspace/personal/memory 2>/dev/null || true
# chown individual dirs (not -R) to avoid EPERM on .archil system files
chown worker:worker /workspace/personal 2>/dev/null || true
chown worker:worker /workspace/personal/memory 2>/dev/null || true

# Role defaults to worker, can be set to "lead"
ROLE="${AGENT_ROLE:-worker}"
MCP_URL="${MCP_BASE_URL:-http://host.docker.internal:3013}"

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
    # Unmount Archil disks (flushes pending data to backing store)
    if [ -n "$ARCHIL_MOUNT_TOKEN" ]; then
        echo "Unmounting Archil disks..."
        archil unmount /workspace/shared 2>/dev/null || true
        archil unmount /workspace/personal 2>/dev/null || true
    fi
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
            jq -r '.configs[] | select(.key != "codex_oauth") | "\(.key)=" + (.value | @sh)' /tmp/swarm_config.json > /tmp/swarm_config.env 2>/dev/null || true
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

# ---- agent-fs registration ----
if [ -n "$AGENT_FS_API_URL" ] && [ -n "$AGENT_ID" ]; then
  if [ -z "$AGENT_FS_API_KEY" ]; then
    echo "[agent-fs] Registering with agent-fs at $AGENT_FS_API_URL..."
    AF_EMAIL="${AGENT_EMAIL:-${AGENT_ID}@swarm.local}"

    AF_RESULT=$(curl -s -X POST "${AGENT_FS_API_URL}/auth/register" \
      -H "Content-Type: application/json" \
      -d "{\"email\": \"$AF_EMAIL\"}" 2>/dev/null) || true

    AF_API_KEY=$(echo "$AF_RESULT" | jq -r '.apiKey // empty')

    if [ -n "$AF_API_KEY" ]; then
      echo "[agent-fs] Registered successfully, storing API key..."
      # Store as agent-scoped secret
      curl -s -X PUT "${MCP_URL}/api/config" \
        -H "Authorization: Bearer ${API_KEY}" \
        -H "Content-Type: application/json" \
        -d "{
          \"scope\": \"agent\",
          \"scopeId\": \"${AGENT_ID}\",
          \"key\": \"AGENT_FS_API_KEY\",
          \"value\": \"${AF_API_KEY}\",
          \"isSecret\": true,
          \"description\": \"agent-fs API key for ${AF_EMAIL}\"
        }" > /dev/null 2>&1 || true

      export AGENT_FS_API_KEY="$AF_API_KEY"
      echo "[agent-fs] API key stored and exported"
    else
      echo "[agent-fs] Registration failed or already registered: $(echo "$AF_RESULT" | jq -r '.error // .message // "unknown error"')"
    fi
  else
    echo "[agent-fs] Already registered (API key present)"
  fi

  # Lead-specific: create shared org
  if [ "$AGENT_ROLE" = "lead" ] && [ -n "$AGENT_FS_API_KEY" ]; then
    if [ -z "$AGENT_FS_SHARED_ORG_ID" ]; then
      echo "[agent-fs] Lead: Creating shared org..."
      AF_ORG_RESULT=$(curl -s -X POST "${AGENT_FS_API_URL}/orgs" \
        -H "Authorization: Bearer ${AGENT_FS_API_KEY}" \
        -H "Content-Type: application/json" \
        -d '{"name": "swarm"}' 2>/dev/null) || true

      AF_SHARED_ORG_ID=$(echo "$AF_ORG_RESULT" | jq -r '.orgId // .id // empty')

      if [ -n "$AF_SHARED_ORG_ID" ]; then
        echo "[agent-fs] Shared org created: $AF_SHARED_ORG_ID"
        # Store as global config so all agents see it
        curl -s -X PUT "${MCP_URL}/api/config" \
          -H "Authorization: Bearer ${API_KEY}" \
          -H "Content-Type: application/json" \
          -d "{
            \"scope\": \"global\",
            \"key\": \"AGENT_FS_SHARED_ORG_ID\",
            \"value\": \"${AF_SHARED_ORG_ID}\",
            \"isSecret\": false,
            \"description\": \"agent-fs shared org ID for the swarm\"
          }" > /dev/null 2>&1 || true

        export AGENT_FS_SHARED_ORG_ID="$AF_SHARED_ORG_ID"

        # Create a one-time task for the lead to invite workers
        echo "[agent-fs] Creating invitation task for lead..."
        curl -s -X POST "${MCP_URL}/api/tasks" \
          -H "Authorization: Bearer ${API_KEY}" \
          -H "Content-Type: application/json" \
          -d "{
            \"task\": \"Invite workers to agent-fs shared org (${AF_SHARED_ORG_ID}). For each worker: check their AGENT_EMAIL config (or default to {agentId}@swarm.local), then run: agent-fs --org ${AF_SHARED_ORG_ID} org invite --email <worker-email> --role editor. Skip any already invited.\",
            \"agentId\": \"${AGENT_ID}\",
            \"source\": \"system\"
          }" > /dev/null 2>&1 || true
      else
        echo "[agent-fs] Failed to create shared org: $(echo "$AF_ORG_RESULT" | jq -r '.error // .message // "unknown"')"
      fi
    else
      echo "[agent-fs] Shared org already exists: $AGENT_FS_SHARED_ORG_ID"
    fi
  fi
fi
# ---- End agent-fs registration ----

# Create .mcp.json in /workspace (project-level config)
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

    echo "GitHub authentication configured successfully"
    echo "Git user: $GIT_NAME <$GIT_EMAIL>"
else
    echo "WARNING: GITHUB_TOKEN not set - GitHub git push operations will fail"
fi
echo "=============================="

# Configure GitLab authentication if token is provided
echo ""
echo "=== GitLab Authentication ==="
if [ -n "$GITLAB_TOKEN" ]; then
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

                # Ensure parent directory exists
                mkdir -p "$(dirname "$REPO_DIR")"

                if [ -d "${REPO_DIR}/.git" ]; then
                    echo "  Pulling ${REPO_NAME} (${REPO_BRANCH}) at ${REPO_DIR}..."
                    cd "$REPO_DIR" && git pull origin "$REPO_BRANCH" --ff-only 2>/dev/null || echo "  Warning: Could not pull ${REPO_NAME}"
                    cd /workspace
                else
                    echo "  Cloning ${REPO_NAME} to ${REPO_DIR} (branch: ${REPO_BRANCH})..."
                    gh repo clone "$REPO_URL" "$REPO_DIR" -- --branch "$REPO_BRANCH" --single-branch 2>/dev/null || echo "  Warning: Could not clone ${REPO_NAME}"
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

        if [ -n "$GLOBAL_SCRIPT" ] || [ -n "$AGENT_SCRIPT" ]; then
            EXISTING_STARTUP=$(find_startup_script) || true

            if [ -n "$EXISTING_STARTUP" ]; then
                # Prepend to existing file (preserve operator content)
                echo "Prepending DB setup script to existing ${EXISTING_STARTUP}..."
                TEMP_FILE=$(mktemp)
                echo "#!/bin/bash" > "$TEMP_FILE"
                # Global script goes outside markers (not synced back to agent DB)
                if [ -n "$GLOBAL_SCRIPT" ]; then
                    echo "# --- Global setup script ---" >> "$TEMP_FILE"
                    echo "$GLOBAL_SCRIPT" >> "$TEMP_FILE"
                    echo "" >> "$TEMP_FILE"
                fi
                # Agent script goes between markers (synced back to DB by hooks)
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
            else
                # Create new start-up.sh
                echo "Creating /workspace/start-up.sh from DB setup script..."
                echo "#!/bin/bash" > /workspace/start-up.sh
                if [ -n "$GLOBAL_SCRIPT" ]; then
                    echo "# --- Global setup script ---" >> /workspace/start-up.sh
                    echo "$GLOBAL_SCRIPT" >> /workspace/start-up.sh
                    echo "" >> /workspace/start-up.sh
                fi
                if [ -n "$AGENT_SCRIPT" ]; then
                    echo "# === Agent-managed setup (from DB) ===" >> /workspace/start-up.sh
                    echo "$AGENT_SCRIPT" >> /workspace/start-up.sh
                    echo "# === End agent-managed setup ===" >> /workspace/start-up.sh
                fi
                chmod +x /workspace/start-up.sh
            fi
            echo "Setup scripts composed (global: $([ -n "$GLOBAL_SCRIPT" ] && echo "yes" || echo "no"), agent: $([ -n "$AGENT_SCRIPT" ] && echo "yes" || echo "no"))"
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


# Execute startup script if found
STARTUP_SCRIPT_STRICT="${STARTUP_SCRIPT_STRICT:-true}"
echo ""
echo "=== Startup Script Detection (${ROLE}) ==="

# Find startup script matching /workspace/start-up.* pattern
STARTUP_SCRIPT=$(find_startup_script) || true

if [ -n "$STARTUP_SCRIPT" ]; then
    echo "Found startup script: $STARTUP_SCRIPT"

    # Check if file is executable
    if [ ! -x "$STARTUP_SCRIPT" ]; then
        echo "Script is not executable, checking for shebang..."
    fi

    # Read first line to check for shebang
    FIRST_LINE=$(head -n 1 "$STARTUP_SCRIPT")

    if [[ "$FIRST_LINE" =~ ^#! ]]; then
        # Has shebang - extract interpreter
        INTERPRETER="${FIRST_LINE#\#!}"
        # Trim whitespace
        INTERPRETER=$(echo "$INTERPRETER" | xargs)
        echo "Detected shebang interpreter: $INTERPRETER"

        # Check if it's an env-based shebang (#!/usr/bin/env bash)
        if [[ "$INTERPRETER" =~ ^/usr/bin/env ]]; then
            ACTUAL_INTERPRETER=$(echo "$INTERPRETER" | awk '{print $2}')
            echo "Using env interpreter: $ACTUAL_INTERPRETER"
            INTERPRETER="$ACTUAL_INTERPRETER"
        fi

        echo "Executing startup script with interpreter: $INTERPRETER"
        # Always use the interpreter explicitly to avoid permission issues
        # Use || true to prevent set -e from exiting before we can handle the error
        $INTERPRETER "$STARTUP_SCRIPT" || EXIT_CODE=$?
        EXIT_CODE=${EXIT_CODE:-0}
    else
        # No shebang, try to infer from extension
        EXTENSION="${STARTUP_SCRIPT##*.}"
        echo "No shebang found, inferring from extension: .$EXTENSION"

        case "$EXTENSION" in
            sh|bash)
                echo "Executing with bash..."
                bash "$STARTUP_SCRIPT" || EXIT_CODE=$?
                ;;
            js)
                echo "Executing with node..."
                node "$STARTUP_SCRIPT" || EXIT_CODE=$?
                ;;
            ts)
                echo "Executing with bun (TypeScript)..."
                bun run "$STARTUP_SCRIPT" || EXIT_CODE=$?
                ;;
            bun)
                echo "Executing with bun..."
                bun run "$STARTUP_SCRIPT" || EXIT_CODE=$?
                ;;
            *)
                # Try to execute directly if executable
                if [ -x "$STARTUP_SCRIPT" ]; then
                    echo "Executing directly (executable bit set)..."
                    "$STARTUP_SCRIPT" || EXIT_CODE=$?
                else
                    echo "WARNING: Unknown extension and not executable, trying bash..."
                    bash "$STARTUP_SCRIPT" || EXIT_CODE=$?
                fi
                ;;
        esac
        EXIT_CODE=${EXIT_CODE:-0}
    fi

    # Handle exit code
    if [ $EXIT_CODE -ne 0 ]; then
        echo ""
        echo "ERROR: Startup script failed with exit code $EXIT_CODE"

        if [ "$STARTUP_SCRIPT_STRICT" = "true" ]; then
            echo "STARTUP_SCRIPT_STRICT=true - Exiting..."
            exit $EXIT_CODE
        else
            echo "STARTUP_SCRIPT_STRICT=false - Continuing despite error..."
        fi
    else
        echo "Startup script completed successfully"
    fi
else
    echo "No startup script found (looked for /workspace/start-up.*)"
    echo "Skipping startup script execution"
fi

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

    # Safety net: if top-level dirs don't exist yet (API still booting),
    # retry a few times with backoff
    if [ -n "$ARCHIL_MOUNT_TOKEN" ]; then
        for attempt in 1 2 3; do
            if [ -d "$AGENT_SHARED/thoughts" ]; then
                break
            fi
            echo "Waiting for shared directory structure (attempt $attempt/3)..."
            sleep 3
        done
    fi

    echo "Setting up per-agent directories for $AGENT_ID..."

    # The shared disk is already mounted via `archil mount --shared`.
    # Read access to ALL directories (including other agents') is automatic.
    # Here we claim WRITE ownership of this agent's own subdirectories only.
    #
    # IMPORTANT: Top-level dirs (thoughts/, memory/, downloads/, misc/) are
    # pre-created by the API machine at boot. This ensures our mkdir below
    # auto-grants delegation at the SUBDIR level (e.g., thoughts/$AGENT_ID),
    # not the parent level (thoughts/). See Appendix A in the plan for details.

    for category in "thoughts" "memory" "downloads" "misc"; do
        AGENT_DIR="$AGENT_SHARED/$category/$AGENT_ID"

        # Create our subdir (auto-grants delegation on $AGENT_ID level)
        # Entrypoint runs as root, so no sudo needed for mkdir.
        mkdir -p "$AGENT_DIR" 2>/dev/null || true

        # Checkout for persistent ownership (survives reboots where dir already exists)
        # Use -f (force) to reclaim stale delegations from destroyed/redeployed machines.
        # Each agent is the sole writer for its own subdirectory, so force is safe.
        # Use `yes` piped in to auto-confirm the force-checkout prompt (no --yes flag).
        # No sudo — entrypoint runs as root; sudo can swallow stdin pipes.
        if [ -n "$ARCHIL_MOUNT_TOKEN" ]; then
            yes | archil checkout -f "$AGENT_DIR" 2>/dev/null || true
        fi

        # chown AFTER checkout — need Archil delegation before FUSE allows chown
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
if [ -n "$AGENT_ID" ] && [ -n "$API_KEY" ] && [ -n "$MCP_BASE_URL" ]; then
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

        # Install complex remote skills via npx
        echo "$SKILLS_RESPONSE" | jq -r '.skills[] | select(.isComplex == true) | .sourceRepo // empty' 2>/dev/null | while read -r repo; do
            if [ -n "$repo" ]; then
                npx skills add "$repo" -a claude-code -a pi -g -y 2>&1 || echo "[entrypoint] Warning: failed to install complex skill from $repo"
            fi
        done

        echo "[entrypoint] Skill sync complete"
    else
        echo "[entrypoint] No skills response from API (server may still be booting)"
    fi
else
    echo "[entrypoint] Skipping skill sync (missing AGENT_ID, API_KEY, or MCP_BASE_URL)"
fi

echo ""

# Run the agent using compiled binary
echo "Starting $ROLE..."
exec gosu worker /usr/local/bin/agent-swarm "$ROLE" "$@"
