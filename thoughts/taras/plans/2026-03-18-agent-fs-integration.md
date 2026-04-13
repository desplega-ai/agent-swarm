---
date: 2026-03-18
author: Claude
status: completed
research: thoughts/taras/research/2026-03-18-agent-fs-integration.md
autonomy: verbose
---

# Agent-FS Native Integration Plan

## Overview

Integrate agent-fs (persistent, searchable filesystem for AI agents) into agent-swarm as a conditional, CLI-based storage backend. When `AGENT_FS_API_URL` is set as a global swarm config, agents register with agent-fs at boot, the lead creates a shared org/drive, and the base system prompt teaches agents to use the `agent-fs` CLI for thoughts, research, plans, and shared documents.

## Current State Analysis

- Agents store thoughts/docs on **Archil FUSE-mounted shared disks** (`/workspace/shared/thoughts/{agentId}/`) in Docker, or **git-tracked `thoughts/` directories** in local dev
- The base system prompt (`BASE_PROMPT_FILESYSTEM` at `src/prompts/base-prompt.ts:228-304`) hardcodes `/workspace/shared/` paths
- **Zero** references to agent-fs exist in the codebase — clean namespace
- The swarm config system (`swarm_config` table, `POST /api/config` HTTP endpoint) supports global/agent/repo scopes with secrets
- Config injection flows through: `docker-entrypoint.sh` (boot) → `fetchResolvedEnv()` (per-task) → `Bun.spawn()` env
- The Docker image installs CLI tools via npm global (`@desplega.ai/wts`, `pm2`, etc.) and Claude plugins via `claude plugin add`

### Key Discoveries:
- `POST /api/config` accepts `{scope, scopeId, key, value, isSecret, description}` for config upsert (`src/http/config.ts:144-175`)
- `getBasePrompt()` uses `process.env` indirectly — the function doesn't access it, but the static suffix is built at call time so we CAN check `process.env` there (`src/prompts/base-prompt.ts:477-509`)
- Swarm config fetch in entrypoint exports all config as env vars via `set -a` + source (`docker-entrypoint.sh:150-174`)
- The entrypoint injection point for new bootstrap logic is between config fetch (line 174) and MCP config creation (line 176)
- Claude plugins are installed at build time with `|| true` fallback (`Dockerfile.worker:88-97`)
- CLI tools install between lines 121-131 of Dockerfile.worker (after archil, before agent-swarm binary copy)

## Desired End State

When `AGENT_FS_API_URL` is set as a global swarm config:

1. **Every agent** auto-registers with agent-fs at first boot and stores its API key as an agent-scoped secret
2. **The lead** creates a shared "swarm" org with a default drive and gets a task to invite workers dynamically
3. **The system prompt** includes agent-fs CLI instructions (write, cat, search, comment) with personal and shared drive usage
4. **Agents use `agent-fs` CLI** via Bash tool for all thoughts, research, plans, and shared documents — no longer writing to `/workspace/shared/thoughts/`
5. **Local filesystem** continues to work for repos, artifacts, scripts, PM2 state
6. **When `AGENT_FS_API_URL` is NOT set**, everything works exactly as before — zero behavioral change

### Verification of End State:
- `docker exec <worker> env | grep AGENT_FS` shows both `AGENT_FS_API_URL` and `AGENT_FS_API_KEY`
- `docker exec <worker> agent-fs whoami` returns the agent's identity
- `docker exec <worker> agent-fs ls thoughts/` works on the personal drive
- `docker exec <worker> agent-fs --org <sharedOrgId> ls /` works on the shared drive
- The system prompt in a task session includes the agent-fs instructions section
- Without `AGENT_FS_API_URL`, the system prompt uses only the existing `BASE_PROMPT_FILESYSTEM`

## Quick Verification Reference

Common commands:
- `bun run lint:fix` — Biome lint + format
- `bun run tsc:check` — TypeScript type check
- `bun test` — Unit tests
- `docker build -f Dockerfile.worker -t agent-swarm-worker:test .` — Docker build test

Key files:
- `Dockerfile.worker` — Docker image build (CLI + plugin install)
- `docker-entrypoint.sh` — Bootstrap logic (registration, shared org)
- `src/prompts/base-prompt.ts` — System prompt with agent-fs instructions
- `src/http/config.ts` — Config API (used by entrypoint for storing keys)

## What We're NOT Doing

- **No MCP server for agent-fs** — CLI only (avoids tool bloat, research decision #4)
- **No migration of existing thoughts** — new content goes to agent-fs, existing local thoughts stay (research decision #5)
- **No dashboard UI integration** — humans access via `live.agent-fs.dev` (research decision #6)
- **No changes to runner.ts or claude-adapter.ts** — `fetchResolvedEnv()` already handles env injection
- **No changes to hook.ts** — CLAUDE.md writing is separate from base prompt
- **No template CLAUDE.md changes** — base prompt overrides template filesystem references
- **No `--drive` flag support** — single shared drive per org is sufficient (research caveat acknowledged)

## Implementation Approach

The integration follows the same conditional pattern as Archil (`ARCHIL_MOUNT_TOKEN`): feature-flagged on `AGENT_FS_API_URL`, zero impact when absent. The entrypoint handles registration and org setup imperatively (curl calls), the base prompt conditionally includes CLI instructions, and the existing config resolution pipeline (`fetchResolvedEnv()`) handles env var propagation without code changes.

---

## Phase 1: Dockerfile.worker — Install agent-fs CLI + Plugin

### Overview
Add the `agent-fs` CLI binary and Claude Code plugin to the Docker worker image. This is a prerequisite for all subsequent phases — agents need the binary available to use the CLI, and the plugin provides the skill that teaches agents CLI commands on-demand.

### Changes Required:

#### 1. Install agent-fs CLI binary
**File**: `Dockerfile.worker`
**Where**: In the existing `npm install -g` block (lines 122-128) — combine into a single RUN layer for Docker cache efficiency
**Changes**: Add `@desplega.ai/agent-fs` to the existing npm global install:
```dockerfile
# Install global npm tools (pinned versions for cache stability)
USER root
RUN npm install -g \
    pm2@6.0.14 \
    @sentry/cli@3.3.0 \
    @desplega.ai/wts@0.2.2 \
    @desplega.ai/localtunnel@2.2.0 \
    @desplega.ai/qa-use@2.8.7 \
    @desplega.ai/agent-fs@latest \
    && qa-use install-deps
```

This keeps it in a single layer with other npm globals, which is the existing Docker optimization pattern. The package is infrequently updated, so it benefits from layer caching.

#### 2. Install agent-fs Claude Code plugin
**File**: `Dockerfile.worker`
**Where**: In the existing Claude plugin marketplace block (lines 88-97) — follows the `claude plugin marketplace add` + `claude plugin install` pattern used by all other plugins
**Changes**: Add agent-fs plugin installation:
```dockerfile
RUN mkdir -p /home/worker/.claude \
    && claude plugin marketplace add desplega-ai/ai-toolbox || true \
    && claude plugin install desplega@desplega-ai-toolbox --scope user || true \
    && claude plugin install agent-swarm@desplega-ai-toolbox --scope user || true \
    && claude plugin install wts@desplega-ai-toolbox --scope user || true \
    && claude plugin marketplace add desplega-ai/qa-use || true \
    && claude plugin install qa-use@desplega.ai --scope user || true \
    && claude plugin marketplace add mksglu/claude-context-mode || true \
    && claude plugin install context-mode@claude-context-mode --scope user || true \
    && claude plugin marketplace add desplega-ai/agent-fs || true \
    && claude plugin install agent-fs@desplega-ai-agent-fs --scope user || true
```

**Note**: Plugins are installed at Docker build time (not in the entrypoint — verified: zero "plugin" references in `docker-entrypoint.sh`). The plugin provides the `agent-fs` skill (CLI reference, `skills/agent-fs/SKILL.md`) that auto-injects on relevant Bash tool calls. The plugin’s MCP server won’t be active because it’s not in `enabledMcpjsonServers` (line 107).

**Pre-requisite**: Verify the agent-fs plugin is published to the Claude Code marketplace before implementation. If not yet published, skip this step and install the skill files directly by copying them into the Docker image (from `../agent-fs/skills/agent-fs/` to `/home/worker/.claude/skills/agent-fs/`).

### Success Criteria:

#### Automated Verification:
- [x] Docker build succeeds: `docker build -f Dockerfile.worker -t agent-swarm-worker:test .`
- [x] agent-fs binary exists in image: `docker run --rm agent-swarm-worker:test which agent-fs`
- [x] agent-fs version works: `docker run --rm agent-swarm-worker:test agent-fs --version`
- [x] Plugin installed: `docker run --rm -u worker agent-swarm-worker:test claude plugin list 2>/dev/null | grep agent-fs`

#### Manual Verification:
- [x] Docker image builds without errors or warnings related to agent-fs
- [x] The image size increase is reasonable (< 50MB)

**Implementation Note**: After completing this phase, pause for manual confirmation before proceeding to Phase 2.

---

## Phase 2: docker-entrypoint.sh — Agent-fs Bootstrap (Worker Registration)

### Overview
Add conditional agent-fs registration logic to the Docker entrypoint. When `AGENT_FS_API_URL` is in the environment (from swarm config), each agent registers with agent-fs at boot if it doesn't already have an API key. The key is stored as an agent-scoped secret via the swarm config API.

### Changes Required:

#### 1. Agent-fs registration block
**File**: `docker-entrypoint.sh`
**Where**: After swarm config fetch (line 174), before MCP config creation (line 176)
**Changes**: Add a new conditional block:

```bash
# === agent-fs registration ===
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
      curl -s -X POST "${MCP_URL}/api/config" \
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
fi
```

**Key design decisions**:
- **Idempotent on restart**: The swarm config fetch at lines 150-174 runs BEFORE this block. On restart, `AGENT_FS_API_KEY` (stored as agent-scoped secret on first boot) is already loaded via `GET /api/config/resolved?agentId=...&includeSecrets=true` → exported via `set -a`. The `if [ -z "$AGENT_FS_API_KEY" ]` check sees the value and skips registration entirely.
- **Fail-safe**: Uses `|| true` and `/dev/null` redirects — agent-fs being down doesn't block the agent from booting
- **Email identity**: Uses `AGENT_EMAIL` env var if set, falls back to `{AGENT_ID}@swarm.local` (research decision #12)
- **Config storage**: Uses `POST /api/config` with `scope: "agent"` and `isSecret: true` (`src/http/config.ts:144-175`)

### Success Criteria:

#### Automated Verification:
- [x] Entrypoint script has no syntax errors: `bash -n docker-entrypoint.sh`
- [x] Shellcheck passes on the new block: `shellcheck docker-entrypoint.sh` (warnings acceptable)

#### Manual Verification:
- [x] With `AGENT_FS_API_URL` set and agent-fs server running: worker registers and API key appears in `GET /api/config/resolved?agentId=<id>&includeSecrets=true`
- [x] With `AGENT_FS_API_URL` NOT set: no agent-fs output in boot logs
- [x] Second boot (API key already stored): logs "Already registered" and skips registration
- [x] With agent-fs server down: boot continues normally with a warning log

**Implementation Note**: This phase requires an agent-fs server running locally for manual verification. Use `AGENT_FS_HOME=/tmp/agent-fs-test agent-fs onboard -y && agent-fs daemon start` to start one. Pause for manual confirmation before proceeding.

---

## Phase 3: docker-entrypoint.sh — Agent-fs Bootstrap (Lead Orchestration)

### Overview
Add lead-specific logic to create a shared org/drive in agent-fs. The lead creates the “swarm” org on first boot (if `AGENT_FS_SHARED_ORG_ID` isn’t already set), stores the org ID as a global config, and creates a task for itself to handle agent invitations dynamically (since agents may use custom `AGENT_EMAIL` values that can’t be predicted in the entrypoint).

### Changes Required:

#### 1. Lead shared org creation
**File**: `docker-entrypoint.sh`
**Where**: Inside the agent-fs registration block from Phase 2, after the API key section, gated on `AGENT_ROLE`
**Changes**: Add lead-specific org creation logic:

```bash
  # Lead-specific: create shared org
  if [ “$AGENT_ROLE” = “lead” ] && [ -n “$AGENT_FS_API_KEY” ]; then
    if [ -z “$AGENT_FS_SHARED_ORG_ID” ]; then
      echo “[agent-fs] Lead: Creating shared org...”
      AF_ORG_RESULT=$(curl -s -X POST “${AGENT_FS_API_URL}/orgs” \
        -H “Authorization: Bearer ${AGENT_FS_API_KEY}” \
        -H “Content-Type: application/json” \
        -d ‘{“name”: “swarm”}’ 2>/dev/null) || true

      AF_SHARED_ORG_ID=$(echo “$AF_ORG_RESULT” | jq -r ‘.orgId // .id // empty’)

      if [ -n “$AF_SHARED_ORG_ID” ]; then
        echo “[agent-fs] Shared org created: $AF_SHARED_ORG_ID”
        # Store as global config so all agents see it
        curl -s -X POST “${MCP_URL}/api/config” \
          -H “Authorization: Bearer ${API_KEY}” \
          -H “Content-Type: application/json” \
          -d “{
            \”scope\”: \”global\”,
            \”key\”: \”AGENT_FS_SHARED_ORG_ID\”,
            \”value\”: \”${AF_SHARED_ORG_ID}\”,
            \”isSecret\”: false,
            \”description\”: \”agent-fs shared org ID for the swarm\”
          }” > /dev/null 2>&1 || true

        export AGENT_FS_SHARED_ORG_ID=”$AF_SHARED_ORG_ID”

        # Create a one-time task for the lead to invite workers
        # (only on first org creation — not on restart)
        echo “[agent-fs] Creating invitation task for lead...”
        curl -s -X POST “${MCP_URL}/api/tasks” \
          -H “Authorization: Bearer ${API_KEY}” \
          -H “Content-Type: application/json” \
          -d “{
            \”task\”: \”Invite workers to agent-fs shared org (${AGENT_FS_SHARED_ORG_ID}). For each worker: check their AGENT_EMAIL config (or default to {agentId}@swarm.local), then run: agent-fs --org ${AGENT_FS_SHARED_ORG_ID} org invite --email <worker-email> --role editor. Skip any already invited.\”,
            \”agentId\”: \”${AGENT_ID}\”,
            \”source\”: \”system\”
          }” > /dev/null 2>&1 || true
      else
        echo “[agent-fs] Failed to create shared org: $(echo “$AF_ORG_RESULT” | jq -r ‘.error // .message // “unknown”’)”
      fi
    else
      echo “[agent-fs] Shared org already exists: $AGENT_FS_SHARED_ORG_ID”
    fi
  fi
```

**Key design decisions**:
- **Idempotent**: Checks `AGENT_FS_SHARED_ORG_ID` before creating — skips if already exists
- **Task-based invitations**: Instead of hardcoding invite logic in the entrypoint (which would fail for agents with custom `AGENT_EMAIL`), creates a task for the lead to handle invitations dynamically. The lead can ask each worker for their email and invite them properly.
- **One-time task**: The invitation task is created only when the org is first created (inside the `if [ -z “$AGENT_FS_SHARED_ORG_ID” ]` block), not on every restart.
- **Task API format**: Uses `POST /api/tasks` (`src/http/tasks.ts:46-68`) with body `{task, agentId, source}` — where `task` is the only required field.
- **Fail-safe**: All curl calls have `|| true` — agent-fs issues don’t prevent boot
- **Role check**: Uses `$AGENT_ROLE` env var (set in Dockerfile at line 165, default `worker`). The lead container passes `-e AGENT_ROLE=lead` at `docker run` time.

### Success Criteria:

#### Automated Verification:
- [x] Entrypoint script has no syntax errors: `bash -n docker-entrypoint.sh`

#### Manual Verification:
- [x] Lead boot with agent-fs: shared org created, `AGENT_FS_SHARED_ORG_ID` appears in global config
- [x] Second lead boot: logs “Shared org already exists” and skips creation
- [x] Invitation task created for the lead in the task queue
- [x] Lead boot without agent-fs: no agent-fs output in logs

**Implementation Note**: Test with the full E2E Docker setup (API + lead + worker containers). Pause for manual confirmation before proceeding.

---

## Phase 4: base-prompt.ts — Conditional Agent-fs Instructions

### Overview
Add a new `BASE_PROMPT_AGENT_FS` constant with CLI usage instructions and conditionally include it in the system prompt when `process.env.AGENT_FS_API_URL` is set. This replaces the local filesystem instructions for thoughts/docs while keeping the existing `BASE_PROMPT_FILESYSTEM` for general workspace guidance.

### Changes Required:

#### 1. New agent-fs prompt constant
**File**: `src/prompts/base-prompt.ts`
**Where**: After `BASE_PROMPT_FILESYSTEM` definition (after line 304)
**Changes**: Add new constant:

```typescript
const BASE_PROMPT_AGENT_FS = `
## Agent Filesystem (agent-fs)

You have access to agent-fs — a persistent, searchable filesystem shared across the swarm.
Use the \`agent-fs\` CLI for all thoughts, research, plans, and shared documents.

The \`agent-fs\` skill (from the agent-fs Claude Code plugin) provides a full CLI reference —
it auto-injects on relevant Bash tool calls. You can also run \`agent-fs docs\` for
interactive CLI documentation.

### Writing to your personal drive (default)
\`\`\`bash
agent-fs write thoughts/research/YYYY-MM-DD-topic.md --content "..." -m "description"
echo "content" | agent-fs write thoughts/plans/YYYY-MM-DD-topic.md -m "description"
\`\`\`

### Writing to the shared drive
Use the same directory structure as the personal drive, namespaced by your agent ID:
\`\`\`bash
# Structured files: thoughts/{agentId}/{type}/YYYY-MM-DD-name.md
agent-fs --org {sharedOrgId} write thoughts/{agentId}/research/YYYY-MM-DD-topic.md --content "..." -m "research findings"
agent-fs --org {sharedOrgId} write thoughts/{agentId}/plans/YYYY-MM-DD-topic.md --content "..." -m "implementation plan"

# Random/misc files: misc/{agentId}/name.ext
agent-fs --org {sharedOrgId} write misc/{agentId}/notes.md --content "..." -m "misc notes"

# Shared documents (not agent-namespaced): docs/name.md
agent-fs --org {sharedOrgId} write docs/shared-report.md --content "..." -m "for team review"
\`\`\`

### Reading and searching
\`\`\`bash
agent-fs cat thoughts/research/2026-03-18-topic.md
agent-fs fts "authentication"          # keyword search across all files
agent-fs search "how does auth work"   # semantic search
agent-fs ls thoughts/research/         # list files
agent-fs docs                          # interactive CLI documentation
\`\`\`

### Comments (for human-agent collaboration)
\`\`\`bash
agent-fs comment add docs/spec.md --body "Needs clarification on auth flow"
agent-fs comment list docs/spec.md
\`\`\`

Key conventions:
- **Personal drive**: thoughts/{type}/YYYY-MM-DD-topic.md (plans, research, brainstorms)
- **Shared drive**: thoughts/{agentId}/{type}/YYYY-MM-DD-topic.md (same structure, namespaced by your ID)
- **Misc files**: misc/{agentId}/name.ext (shared drive) or misc/name.ext (personal drive)
- Add version messages (-m) to writes for auditability
- All CLI output is JSON — parse it
- Use the shared drive (--org) for documents humans or other agents should review
- Run \`agent-fs docs\` if you need help with any command

Do NOT use the local filesystem (/workspace/shared/thoughts/) for thoughts or shared docs
when agent-fs is available. Local filesystem is still used for: repos, artifacts, scripts,
and any non-thought data.
`;
```

#### 2. Conditional injection in getBasePrompt()
**File**: `src/prompts/base-prompt.ts`
**Where**: In the static suffix construction (line 486)
**Changes**: After the `BASE_PROMPT_FILESYSTEM` injection (line 486), add conditional agent-fs section:

```typescript
// Always include base filesystem instructions
staticSuffix += BASE_PROMPT_FILESYSTEM.replaceAll("{agentId}", agentId);

// Conditionally include agent-fs instructions when available
if (process.env.AGENT_FS_API_URL) {
  const sharedOrgId = process.env.AGENT_FS_SHARED_ORG_ID || "YOUR_SHARED_ORG_ID";
  staticSuffix += BASE_PROMPT_AGENT_FS
    .replaceAll("{agentId}", agentId)
    .replaceAll("{sharedOrgId}", sharedOrgId);
}
```

#### 3. Keep `process.env` in sync with resolved config
**File**: `src/commands/runner.ts`
**Where**: Inside `spawnProviderProcess()`, after `fetchResolvedEnv()` (line 1155), before `buildSystemPrompt()` is called
**Changes**: Propagate agent-fs config values from the resolved env back to `process.env` so that `getBasePrompt()` can read them:

```typescript
const freshEnv = await fetchResolvedEnv(opts.apiUrl, opts.apiKey, opts.agentId);

// Propagate agent-fs config to process.env so getBasePrompt() can read them
// (fetchResolvedEnv returns a new object, doesn't update process.env)
if (freshEnv.AGENT_FS_SHARED_ORG_ID) {
  process.env.AGENT_FS_SHARED_ORG_ID = freshEnv.AGENT_FS_SHARED_ORG_ID;
}
```

**Note**: `buildSystemPrompt()` is called independently of `fetchResolvedEnv()` — they don't share state. Without this propagation, workers that boot before the lead creates the shared org would never see the org ID in the prompt (even though `fetchResolvedEnv()` picks it up per-task). This is a targeted update — only `AGENT_FS_SHARED_ORG_ID` is propagated, not the full env.

**Key design decisions**:
- **Additive, not replacing**: Both `BASE_PROMPT_FILESYSTEM` (local paths) and `BASE_PROMPT_AGENT_FS` are included — the agent-fs section says "do NOT use local filesystem for thoughts" which overrides the local paths for that specific use case
- **`process.env` kept in sync**: `AGENT_FS_API_URL` is available at boot from the entrypoint's `set -a` export. `AGENT_FS_SHARED_ORG_ID` is propagated from the resolved env per-task to handle the case where the lead creates the org after the worker starts.
- **Shared org fallback**: If `AGENT_FS_SHARED_ORG_ID` isn't available yet, a `"YOUR_SHARED_ORG_ID"` placeholder is shown. On the next task, the resolved env picks it up and propagates it to `process.env`.

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run tsc:check`
- [x] Linting passes: `bun run lint:fix`
- [x] Existing tests pass: `bun test`

#### Manual Verification:
- [x] With `AGENT_FS_API_URL` set in env: `getBasePrompt()` output includes "Agent Filesystem (agent-fs)" section
- [x] Without `AGENT_FS_API_URL`: `getBasePrompt()` output does NOT include agent-fs section
- [x] The `{agentId}` placeholder is correctly replaced in agent-fs section
- [x] The `{sharedOrgId}` placeholder is correctly replaced with the org ID or fallback

**Implementation Note**: Write a simple test or script to verify the prompt conditional. Pause for manual confirmation before proceeding.

---

## Phase 5: E2E Verification

### Overview
Full end-to-end test of the integration with Docker containers and a local agent-fs server. Verify the complete flow: agent-fs server → Docker build → lead registration + shared org → worker registration → prompt injection → CLI operations from within a container.

### Test Setup:

```bash
# 1. Start a local agent-fs daemon (agent-fs CLI is already installed)
export AGENT_FS_HOME=/tmp/agent-fs-e2e
agent-fs onboard -y                    # sets up local MinIO + DB
agent-fs daemon start                  # starts the API daemon
AF_PORT=$(agent-fs daemon status --json | jq -r '.port // 7433')
AF_URL="http://host.docker.internal:${AF_PORT}"

# 2. Clean DB for fresh state
rm -f agent-swarm-db.sqlite agent-swarm-db.sqlite-wal agent-swarm-db.sqlite-shm

# 3. Start API server
bun run start:http &

# 4. Set AGENT_FS_API_URL as global swarm config
curl -X POST "http://localhost:3013/api/config" \
  -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d "{\"scope\":\"global\",\"key\":\"AGENT_FS_API_URL\",\"value\":\"$AF_URL\",\"isSecret\":false,\"description\":\"agent-fs server URL\"}"

# 5. Build Docker image
docker build -f Dockerfile.worker -t agent-swarm-worker:test .

# 6. Start lead container
docker run --rm -d \
  --name e2e-test-lead \
  --env-file .env.docker-lead \
  -e AGENT_ROLE=lead \
  -e MAX_CONCURRENT_TASKS=1 \
  -p 3201:3000 \
  agent-swarm-worker:test

# 7. Start worker container
docker run --rm -d \
  --name e2e-test-worker \
  --env-file .env.docker \
  -e MAX_CONCURRENT_TASKS=1 \
  -p 3203:3000 \
  agent-swarm-worker:test
```

### Verification Checklist:

#### Automated Verification:
- [x] Lead registered with agent-fs: `docker logs e2e-test-lead 2>&1 | grep "agent-fs.*Registered"`
- [x] Lead created shared org: `docker logs e2e-test-lead 2>&1 | grep "Shared org created"`
- [x] Worker registered with agent-fs: `docker logs e2e-test-worker 2>&1 | grep "agent-fs.*Registered"`
- [x] API keys stored in config: `curl -s -H "Authorization: Bearer 123123" "http://localhost:3013/api/config?scope=agent&includeSecrets=true" | jq '.configs[] | select(.key=="AGENT_FS_API_KEY")'`
- [x] Shared org ID in global config: `curl -s -H "Authorization: Bearer 123123" "http://localhost:3013/api/config?scope=global" | jq '.configs[] | select(.key=="AGENT_FS_SHARED_ORG_ID")'`

#### Manual Verification:
- [x] Worker can use agent-fs CLI: `docker exec e2e-test-worker agent-fs whoami`
- [x] Worker can write to personal drive: `docker exec e2e-test-worker agent-fs write test.md --content "hello" -m "test"`
- [x] Worker can read from personal drive: `docker exec e2e-test-worker agent-fs cat test.md`
- [x] Worker can write to shared drive: `docker exec e2e-test-worker bash -c 'agent-fs --org $AGENT_FS_SHARED_ORG_ID write shared-test.md --content "shared" -m "test"'`
- [x] Create a trivial task and verify the system prompt includes "Agent Filesystem" section
- [x] Without `AGENT_FS_API_URL`: system prompt does NOT include agent-fs section

#### Cleanup:
```bash
docker stop e2e-test-lead e2e-test-worker
kill $(lsof -ti :3013)
agent-fs daemon stop
rm -rf /tmp/agent-fs-e2e
```

**Implementation Note**: This phase is verification-only, no code changes. If issues are found, fix them in the relevant phase and re-verify.

---

## Testing Strategy

### Unit Tests
- Add a test for `getBasePrompt()` that verifies agent-fs section inclusion is conditional on `process.env.AGENT_FS_API_URL`
- Test both with and without the env var set
- Verify placeholder replacement for `{agentId}` and `{sharedOrgId}`

### Integration Tests
- Docker build test (CI already does this via merge gate)
- Entrypoint script syntax check (`bash -n`)

### E2E Tests
- Full Docker flow as described in Phase 5
- Test idempotency: second boot should skip registration
- Test failure mode: agent-fs server down during boot should not block agent startup

## Manual E2E Commands

```bash
# After full implementation, run these commands to verify:

# 0. Start a local agent-fs daemon (agent-fs CLI is already installed)
export AGENT_FS_HOME=/tmp/agent-fs-e2e
agent-fs onboard -y                    # sets up local MinIO + DB
agent-fs daemon start                  # starts the API daemon
AF_PORT=$(agent-fs daemon status --json | jq -r ‘.port // 7433’)
AF_URL="http://host.docker.internal:${AF_PORT}"

# 1. Start the agent-swarm API server
bun run start:http &

# 2. Set AGENT_FS_API_URL as global swarm config
curl -X POST "http://localhost:3013/api/config" \
  -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d "{\"scope\":\"global\",\"key\":\"AGENT_FS_API_URL\",\"value\":\"${AF_URL}\",\"isSecret\":false}"

# 3. Build and start containers
docker build -f Dockerfile.worker -t agent-swarm-worker:test .
docker run --rm -d --name e2e-lead --env-file .env.docker-lead -e AGENT_ROLE=lead -p 3201:3000 agent-swarm-worker:test
docker run --rm -d --name e2e-worker --env-file .env.docker -p 3203:3000 agent-swarm-worker:test

# 4. Verify registration
curl -s -H "Authorization: Bearer 123123" "http://localhost:3013/api/config?includeSecrets=true" | jq ‘.configs[] | select(.key | startswith("AGENT_FS"))’

# 5. Verify CLI works inside container
docker exec e2e-worker agent-fs whoami
docker exec e2e-worker agent-fs write hello.md --content "hello world" -m "test"
docker exec e2e-worker agent-fs cat hello.md

# 6. Verify prompt
docker exec e2e-worker env | grep AGENT_FS

# 7. Cleanup
docker stop e2e-lead e2e-worker
kill $(lsof -ti :3013)
agent-fs daemon stop
rm -rf /tmp/agent-fs-e2e
```

## References

- Research document: `thoughts/taras/research/2026-03-18-agent-fs-integration.md`
- agent-fs codebase: `../agent-fs`
- Resolved decisions: 13 decisions in research doc (CLI over MCP, self-registration, shared org model, email identity, etc.)

---

## Review Errata

_Reviewed: 2026-03-18 by Claude (automated structural + content + codebase verification)_

### Important

_(All items addressed in plan update)_

### Resolved

- [x] **`process.env` gap for `AGENT_FS_SHARED_ORG_ID`** — Added Phase 4 change #3: propagate from resolved env to `process.env` in `spawnProviderProcess()`
- [x] **Task API body format** — Fixed Phase 3 curl body to use `{task, agentId, source}` per `src/http/tasks.ts:46-68`
- [x] **Duplicate invitation tasks on restart** — Moved task creation inside `if [ -z "$AGENT_FS_SHARED_ORG_ID" ]` block
- [x] **No version pin** — Changed to `@desplega.ai/agent-fs@latest` (pin specific version during implementation)
- [x] **Plugin marketplace name unverified** — Added fallback: copy skill files directly if not on marketplace
- [x] Frontmatter uses `author` instead of `planner` — acceptable for this project's conventions
