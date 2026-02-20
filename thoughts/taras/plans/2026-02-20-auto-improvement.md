---
date: 2026-02-20T02:30:00Z
planner: Claude
branch: claw-auto-improvement
repository: agent-swarm
topic: "Auto-Improvement / Setup Scripts — Gap 5 Implementation"
tags: [plan, auto-improvement, setup-script, gap-5, agent-native]
status: completed
autonomy: autopilot
research: thoughts/taras/research/2026-02-19-swarm-gaps-implementation.md
---

# Auto-Improvement / Setup Scripts — Implementation Plan

## Overview

Add persistent, self-evolving setup scripts and environment-specific operational knowledge for agents. Today, agents start every container with the same environment — no way to accumulate tool installations, config tweaks, or workflow improvements across sessions. This plan adds:

1. A `setupScript TEXT` column on `agents` for per-agent setup scripts
2. A `toolsMd TEXT` column on `agents` for environment-specific operational knowledge (TOOLS.md)
3. A global setup script via the existing `swarm_config` table (key `SETUP_SCRIPT`, scope `global`)
4. Docker entrypoint logic to fetch, compose (global + agent), and prepend to any mounted `/workspace/start-up.*`
5. File lifecycle: runner writes setup script + TOOLS.md before spawn, Stop hook syncs edits back to DB
6. Self-improvement directives in SOUL.md template and base prompt, plus a `generateDefaultToolsMd()` template

This is Gap 5 / Phase 6 from the swarm-gaps research (`thoughts/taras/research/2026-02-19-swarm-gaps-implementation.md`).

**Prerequisites**: Gap 6 (Env Management) ✅, Gap 1 (Worker Identity) ✅ — both merged.

## Current State Analysis

**What exists today:**
- **Docker entrypoint startup script mechanism** (`docker-entrypoint.sh:229-326`): Discovers `/workspace/start-up.*` files in priority order (`.sh`, `.bash`, `.js`, `.ts`, `.bun`, no ext). Detects interpreter via shebang or extension. `STARTUP_SCRIPT_STRICT=true` by default (container exits on failure). Runs after config fetch + GitHub auth + marketplace install, before workspace dirs + agent binary.
- **No `setupScript` or `toolsMd` columns** on the `agents` table — confirmed. Only `claudeMd`, `soulMd`, `identityMd` exist.
- **`swarm_config` table** exists with `global`/`agent`/`repo` scoping (Gap 6, merged). Can store a global setup script as a well-known config key.
- **Identity file lifecycle** is the pattern to follow: runner writes files before spawn (`runner.ts:1602-1621`), Stop hook syncs back to DB (`hook.ts:666-695`), PostToolUse hook syncs on edit (`hook.ts:537-553`).
- **`update-profile` MCP tool** (`src/tools/update-profile.ts`) accepts `claudeMd`, `soulMd`, `identityMd` but not `setupScript` or `toolsMd`.
- **`updateAgentProfile()` DB function** (`db.ts:2319-2370`) uses `COALESCE(?, column)` pattern — easy to extend for both new fields.
- **`fetchResolvedEnv()`** (`runner.ts:100-137`) already fetches config from API before each spawn — env vars from swarm_config are available.
- **SOUL.md template** (`db.ts:2240-2278`) has a `## Self-Evolution` section saying "refine your soul", but no mention of setup scripts or environment improvement.
- **Base prompt filesystem section** (`base-prompt.ts:204-218`) mentions `/workspace/personal` for persistence and suggests `memory.txt`/`memory.db`, but says nothing about setup scripts.
- **No post-task reflection**: `checkCompletedProcesses()` (`runner.ts:1365-1392`) only removes from `activeTasks` and calls `ensureTaskFinished()` — no learning extraction.

### Key Discoveries:
- The entrypoint's startup script discovery is first-match: if we write `start-up.sh` and an operator also mounts `start-up.ts`, only `.sh` is found. We must detect the existing file first and prepend to it.
- The config fetch (`docker-entrypoint.sh:88-112`) already runs before the startup script phase — so a new endpoint for setup scripts can follow the same pattern.
- The runner writes identity files at `runner.ts:1602-1621` and the system prompt is rebuilt at `runner.ts:1589` — both happen before any Claude process spawns.
- `writeTaskFile()` creates `/tmp/agent-swarm-task-{pid}.json` with `taskId` + `agentId` — the Stop hook reads this via `TASK_FILE` env var (though it currently doesn't read it in the Stop handler).

## Desired End State

1. Each agent has a `setupScript` field (65KB max, like `claudeMd`) stored in DB
2. Each agent has a `toolsMd` field (65KB max) stored in DB — a 4th identity file for environment-specific operational knowledge
3. A global setup script can be configured via `swarm_config` (key `SETUP_SCRIPT`, scope `global`)
4. On container start, the entrypoint fetches both scripts and composes them into the startup file
5. Agents can edit `/workspace/start-up.sh` and `/workspace/TOOLS.md` during sessions — changes sync to DB on Stop
6. The `update-profile` MCP tool and REST API accept `setupScript` and `toolsMd` updates
7. SOUL.md template includes self-improvement directives about setup script and TOOLS.md
8. Base prompt mentions the setup script mechanism and TOOLS.md
9. A `generateDefaultToolsMd()` template provides structured categories for environment-specific notes (repos, services, SSH hosts, APIs, etc.)

**Verification**: Register an agent, set its `setupScript` via API, start a Docker worker, verify the script runs at container start. Edit the script during a session, stop the worker, verify DB updated. Start again, verify the updated script runs.

## Quick Verification Reference

Common commands:
- `bun run tsc:check` — Type checking
- `bun run lint:fix` — Lint + format
- `bun test` — Run all tests
- `bun run start:http` — Start HTTP server

Key files to check:
- `src/be/db.ts` — Schema, migration, `updateAgentProfile()`, new `getAgentSetupScript()`, `generateDefaultToolsMd()`
- `src/types.ts` — `AgentSchema` with `setupScript` + `toolsMd`
- `docker-entrypoint.sh` — Setup script fetch + compose
- `src/hooks/hook.ts` — Stop hook sync (setup script + TOOLS.md), PostToolUse hook
- `src/commands/runner.ts` — Write setup script + TOOLS.md before spawn
- `src/tools/update-profile.ts` — New `setupScript` + `toolsMd` fields
- `src/prompts/base-prompt.ts` — Self-improvement directives

## What We're NOT Doing

- **Post-task reflection/learning extraction** — belongs to Gap 2 (Memory System), not here
- **Automatic learning propagation** between agents — separate concern
- **Setup script versioning/history** — no audit trail
- **Setup script validation/sandboxing** — agents can self-modify freely (per research decision #4)
- **UI editor for setup scripts or TOOLS.md** — can come later; API + MCP tool sufficient for now
- **Multi-file setup scripts** — single script per agent, stored as TEXT in DB
- **Setup script for leads** — leads don't run in Docker workers typically; skip for now
- **TOOLS.md sharing between agents** — each agent's TOOLS.md is personal; shared knowledge belongs in other mechanisms

## Implementation Approach

Five phases, each independently verifiable:

1. **DB + Types**: Schema migration (`setupScript` + `toolsMd`), type updates, `updateAgentProfile()` extension
2. **API + MCP Tool**: REST endpoint for setup script, `update-profile` extension (both fields), global script via swarm_config
3. **Docker Entrypoint**: Fetch and compose scripts at container start
4. **File Lifecycle**: Runner writes setup script + TOOLS.md before spawn, Stop hook syncs back, PostToolUse detects edits
5. **Self-Improvement Directives + TOOLS.md Template**: `generateDefaultToolsMd()`, SOUL.md update, base prompt update, CLAUDE.md template update

---

## Phase 1: DB Schema + Type System

### Overview
Add `setupScript TEXT` and `toolsMd TEXT` columns to the `agents` table and update all TypeScript types.

### Changes Required:

#### 1. Database Migration
**File**: `src/be/db.ts`
**Changes**: Add column migrations after the existing `identityMd` migration (~line 536):

```typescript
// Setup script (per-agent auto-improvement)
try {
  db.run(`ALTER TABLE agents ADD COLUMN setupScript TEXT`);
} catch { /* exists */ }

// Tools/environment reference (per-agent operational knowledge)
try {
  db.run(`ALTER TABLE agents ADD COLUMN toolsMd TEXT`);
} catch { /* exists */ }
```

#### 2. AgentRow Type
**File**: `src/be/db.ts:714-728`
**Changes**: Add to `AgentRow`:

```typescript
setupScript: string | null;
toolsMd: string | null;
```

#### 3. rowToAgent Function
**File**: `src/be/db.ts:731-748`
**Changes**: Add mappings:

```typescript
setupScript: row.setupScript ?? undefined,
toolsMd: row.toolsMd ?? undefined,
```

#### 4. AgentSchema (Zod)
**File**: `src/types.ts:131-134`
**Changes**: Add after `identityMd`:

```typescript
// Setup script: Runs at container start, agent-evolved (synced to /workspace/start-up.sh)
setupScript: z.string().max(65536).optional(),
// Tools/environment reference: Operational knowledge (synced to /workspace/TOOLS.md)
toolsMd: z.string().max(65536).optional(),
```

#### 5. updateAgentProfile Extension
**File**: `src/be/db.ts:2319-2370`
**Changes**: Add `setupScript?: string` and `toolsMd?: string` to the `updates` parameter type. Add `COALESCE(?, setupScript)` and `COALESCE(?, toolsMd)` to the UPDATE SQL and pass `updates.setupScript ?? null` and `updates.toolsMd ?? null` in the `.get()` call.

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] Existing tests pass: `bun test` (325 pass, 0 fail)
- [x] DB migration runs: `bun run start:http` (start + stop, no errors)

#### Manual Verification:
- [x] SQLite schema has the new columns: `sqlite3 agent-swarm-db.sqlite ".schema agents" | grep -E 'setupScript|toolsMd'`
- [x] GET /me returns `setupScript` and `toolsMd` fields (null for existing agents)

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Phase 2: API Endpoint + MCP Tool

### Overview
Expose setup script via REST API and MCP tool. Add a dedicated `GET /api/agents/:id/setup-script` endpoint for the Docker entrypoint to fetch, and extend `update-profile` to accept `setupScript`.

### Changes Required:

#### 1. Setup Script Fetch Endpoint
**File**: `src/http.ts`
**Changes**: Add a new endpoint in the REST API section (near the existing profile routes around line 968):

```
GET /api/agents/:id/setup-script → { setupScript: string | null, globalSetupScript: string | null }
```

This endpoint:
- Fetches the agent's `setupScript` from the `agents` table
- Fetches the global setup script from `swarm_config` where `scope='global'` and `key='SETUP_SCRIPT'`
- Returns both, so the entrypoint can compose them

Route matching: `pathSegments = ["api", "agents", <id>, "setup-script"]`

#### 2. Extend Profile API
**File**: `src/http.ts:968-1048`
**Changes**: The `PUT /api/agents/:id/profile` endpoint already passes through to `updateAgentProfile()`. Add `setupScript` and `toolsMd` to:
- The body parsing (it already uses `body.setupScript`/`body.toolsMd` if present due to the spread pattern)
- The "at least one field" check (~line 995-999)
- Size validation: max 64KB each, matching `claudeMd` pattern

#### 3. Extend update-profile MCP Tool
**File**: `src/tools/update-profile.ts:14-47`
**Changes**: Add `setupScript` and `toolsMd` to the input schema:

```typescript
setupScript: z.string().max(65536).optional().describe(
  "Setup script content (bash). Runs at container start to install tools, configure environment. Persists across sessions. Also written to /workspace/start-up.sh."
),
toolsMd: z.string().max(65536).optional().describe(
  "Environment-specific operational knowledge. Repos, services, SSH hosts, APIs, device names — anything specific to your setup. Synced to /workspace/TOOLS.md."
),
```

Add both to the "at least one field" check, `updatedFields` tracking, and `updateAgentProfile()` call.

After DB update:
- Write to `/workspace/start-up.sh` if the file doesn't exist or is the agent's own content (not operator-mounted). This mirrors the SOUL.md/IDENTITY.md pattern at lines 125-138.
- Write to `/workspace/TOOLS.md` following the same pattern.

#### 4. Global Setup Script Convention
No code changes needed — the `swarm_config` table already supports this. Document the convention:
- Key: `SETUP_SCRIPT`
- Scope: `global`
- Value: bash script content
- Set via `PUT /api/config` (existing endpoint)

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] Existing tests pass: `bun test` (325 pass, 0 fail)

#### Manual Verification:
- [x] Set agent setupScript via `PUT /api/agents/:id/profile` with `{"setupScript":"#!/bin/bash\necho hello"}` — verify persists
- [x] Fetch via `GET /api/agents/:id/setup-script` — verify returns the script
- [x] Set global script via `PUT /api/config` with `{"scope":"global","key":"SETUP_SCRIPT","value":"#!/bin/bash\necho global"}` — verify returned by the endpoint
- [x] Via MCP tool: agent edited start-up.sh and changes synced to DB via PostToolUse hook
- [x] Via MCP tool: agent edited TOOLS.md and changes synced to DB via PostToolUse hook

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Phase 3: Docker Entrypoint Integration

### Overview
Update the Docker entrypoint to fetch the agent's setup script and global setup script from the API, compose them, and prepend to any existing `/workspace/start-up.*` file before the existing execution mechanism runs.

### Changes Required:

#### 1. Setup Script Fetch + Compose
**File**: `docker-entrypoint.sh`
**Changes**: Add a new section between the AI Tracker setup (line 226) and the existing startup script execution (line 229). This section:

1. Fetches the agent's setup script + global script from the new endpoint
2. Composes: global script first, then agent script (agent-specific additions build on global base)
3. Finds the existing startup file (if any) using the same discovery loop
4. If a startup file exists: prepends the composed script with a marker comment
5. If no startup file exists: creates `/workspace/start-up.sh` with the composed content

```bash
# ---- Fetch and compose setup scripts from API ----
if [ -n "$AGENT_ID" ]; then
    echo "Fetching setup scripts from API..."
    if curl -s -f -H "Authorization: Bearer ${API_KEY}" \
       -H "X-Agent-ID: ${AGENT_ID}" \
       "${MCP_URL}/api/agents/${AGENT_ID}/setup-script" \
       > /tmp/setup_scripts.json 2>/dev/null; then

        GLOBAL_SCRIPT=$(jq -r '.globalSetupScript // empty' /tmp/setup_scripts.json 2>/dev/null)
        AGENT_SCRIPT=$(jq -r '.setupScript // empty' /tmp/setup_scripts.json 2>/dev/null)

        COMPOSED_SCRIPT=""
        if [ -n "$GLOBAL_SCRIPT" ]; then
            COMPOSED_SCRIPT="${GLOBAL_SCRIPT}"
        fi
        if [ -n "$AGENT_SCRIPT" ]; then
            if [ -n "$COMPOSED_SCRIPT" ]; then
                COMPOSED_SCRIPT="${COMPOSED_SCRIPT}
"
            fi
            COMPOSED_SCRIPT="${COMPOSED_SCRIPT}${AGENT_SCRIPT}"
        fi

        if [ -n "$COMPOSED_SCRIPT" ]; then
            # Find existing startup file (same discovery logic as below)
            EXISTING_STARTUP=""
            for pattern in start-up.sh start-up.bash start-up.js start-up.ts start-up.bun start-up; do
                if [ -f "/workspace/${pattern}" ]; then
                    EXISTING_STARTUP="/workspace/${pattern}"
                    break
                fi
            done

            if [ -n "$EXISTING_STARTUP" ]; then
                # Prepend to existing file (preserve operator content)
                echo "Prepending DB setup script to existing ${EXISTING_STARTUP}..."
                TEMP_FILE=$(mktemp)
                echo "#!/bin/bash" > "$TEMP_FILE"
                echo "# === Agent-managed setup (from DB) ===" >> "$TEMP_FILE"
                echo "$COMPOSED_SCRIPT" >> "$TEMP_FILE"
                echo "# === End agent-managed setup ===" >> "$TEMP_FILE"
                echo "" >> "$TEMP_FILE"
                # Strip existing shebang from original to avoid duplicate
                sed '1{/^#!/d;}' "$EXISTING_STARTUP" >> "$TEMP_FILE"
                mv "$TEMP_FILE" "$EXISTING_STARTUP"
                chmod +x "$EXISTING_STARTUP"
            else
                # Create new start-up.sh
                echo "Creating /workspace/start-up.sh from DB setup script..."
                echo "#!/bin/bash" > /workspace/start-up.sh
                echo "# === Agent-managed setup (from DB) ===" >> /workspace/start-up.sh
                echo "$COMPOSED_SCRIPT" >> /workspace/start-up.sh
                echo "# === End agent-managed setup ===" >> /workspace/start-up.sh
                chmod +x /workspace/start-up.sh
            fi
            echo "Setup scripts composed (global: $([ -n "$GLOBAL_SCRIPT" ] && echo "yes" || echo "no"), agent: $([ -n "$AGENT_SCRIPT" ] && echo "yes" || echo "no"))"
        fi
        rm -f /tmp/setup_scripts.json
    else
        echo "Warning: Could not fetch setup scripts (API may not be ready)"
    fi
fi
# ---- End setup script fetch ----
```

**Key decisions:**
- Global script comes first (base environment), agent script second (agent-specific additions)
- Marker comments (`=== Agent-managed setup ===`) allow us to strip the DB portion on sync-back
- If an operator-mounted startup file exists, we prepend rather than replace — operator content is preserved
- The shebang from the original file is stripped to avoid duplicate shebangs
- The composed file always gets a `#!/bin/bash` shebang (the DB-stored content may not have one)

### Success Criteria:

#### Automated Verification:
- [x] Entrypoint syntax valid: `bash -n docker-entrypoint.sh`
- [x] Lint passes: `bun run lint:fix`

#### Manual Verification:
- [x] Set an agent's setupScript via API (verified via curl)
- [x] Build worker image: `docker build -f Dockerfile.worker -t agent-swarm-worker:e2e-test .`
- [x] Start container, check logs for "Setup scripts composed" message
- [x] Verify setup test files exist inside the container (`/tmp/global-setup-test`, `/tmp/agent-setup-test`)
- [x] Restart container — verify no duplication of setup script content (marker stripping works)

**Implementation Note**: After completing this phase, pause for manual confirmation. Docker testing required.

---

## Phase 4: File Lifecycle (Runner + Hooks)

### Overview
Complete the setup script and TOOLS.md lifecycle: runner writes the files before spawn (so the agent can see/edit them), Stop hook syncs edits back to DB, PostToolUse hook syncs on direct edits.

### Changes Required:

#### 1. Runner Writes Setup Script + TOOLS.md Before Spawn
**File**: `src/commands/runner.ts`
**Changes**: After writing SOUL.md and IDENTITY.md (~line 1621), also write the setup script and TOOLS.md:

```typescript
const SETUP_SCRIPT_PATH = "/workspace/start-up.sh";
const TOOLS_MD_PATH = "/workspace/TOOLS.md";

// Write setup script to workspace (agent can edit during session)
if (agentSetupScript) {
  try {
    const file = Bun.file(SETUP_SCRIPT_PATH);
    const exists = await file.exists();
    if (!exists) {
      await Bun.write(SETUP_SCRIPT_PATH, `#!/bin/bash\n${agentSetupScript}\n`);
      log.info("Wrote start-up.sh to workspace");
    }
  } catch (err) {
    log.warn(`Could not write start-up.sh: ${(err as Error).message}`);
  }
}

// Write TOOLS.md to workspace (agent can edit during session)
if (agentToolsMd) {
  try {
    await Bun.write(TOOLS_MD_PATH, agentToolsMd);
    log.info("Wrote TOOLS.md to workspace");
  } catch (err) {
    log.warn(`Could not write TOOLS.md: ${(err as Error).message}`);
  }
}
```

Note: Setup script only creates if it doesn't exist — the entrypoint already composed/prepended it at container start. TOOLS.md always writes (like SOUL.md/IDENTITY.md) since it's a pure identity file with no operator-mounting concern.

Also extend the profile fetch at `runner.ts:1531-1549` to extract `agentSetupScript = profile.setupScript` and `agentToolsMd = profile.toolsMd`.

#### 2. Stop Hook Sync
**File**: `src/hooks/hook.ts`
**Changes**: In the Stop handler (~line 675-683), after `syncIdentityFilesToServer()`, add setup script sync. For TOOLS.md, extend the existing `syncIdentityFilesToServer()` to include it (since TOOLS.md is an identity file and follows the same pattern — this avoids an extra HTTP call):

```typescript
// Sync setup script back to DB (separate — has marker extraction logic)
try {
  await syncSetupScriptToServer(agentInfo.id);
} catch { /* non-blocking */ }
```

**Extend `syncIdentityFilesToServer`** (~line 288-323): Add TOOLS.md alongside the existing SOUL.md and IDENTITY.md reads:

```typescript
const TOOLS_MD_PATH = "/workspace/TOOLS.md";

// Inside syncIdentityFilesToServer, after reading SOUL.md and IDENTITY.md:
try {
  const toolsMdFile = Bun.file(TOOLS_MD_PATH);
  if (await toolsMdFile.exists()) {
    const content = await toolsMdFile.text();
    if (content.trim() && content.length <= 65536) {
      updates.toolsMd = content;
    }
  }
} catch { /* skip */ }
```

This sends `{ soulMd, identityMd, toolsMd }` in a single PUT call, consistent with the existing pattern.

**Add helper function `syncSetupScriptToServer`** (separate because of marker extraction logic):

```typescript
const SETUP_SCRIPT_PATH = "/workspace/start-up.sh";

const syncSetupScriptToServer = async (agentId: string): Promise<void> => {
  if (!mcpConfig) return;

  const file = Bun.file(SETUP_SCRIPT_PATH);
  if (!(await file.exists())) return;

  const raw = await file.text();
  if (!raw.trim()) return;

  const markerStart = "# === Agent-managed setup (from DB) ===";
  const markerEnd = "# === End agent-managed setup ===";
  const startIdx = raw.indexOf(markerStart);
  const endIdx = raw.indexOf(markerEnd);

  let content: string;
  if (startIdx !== -1 && endIdx !== -1) {
    // Markers present — extract ONLY the content between them.
    // Content after the end marker is operator-mounted and must NOT be stored,
    // otherwise it would be duplicated on next container restart (prepend + original).
    content = raw.substring(startIdx + markerStart.length, endIdx).trim();
  } else {
    // No markers — agent created/replaced the entire file. Store as-is minus shebang.
    content = raw.replace(/^#!\/bin\/bash\n/, "").trim();
  }

  if (!content || content.length > 65536) return;

  try {
    await fetch(`${getBaseUrl()}/api/agents/${agentId}/profile`, {
      method: "PUT",
      headers: {
        ...mcpConfig.headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ setupScript: content }),
    });
  } catch { /* silently fail */ }
};
```

**Why extract between markers only:** The entrypoint composes the file as:
```
#!/bin/bash
# === Agent-managed setup (from DB) ===
<agent content>
# === End agent-managed setup ===
<operator's original start-up.sh content>
```
If we stored the full file, operator content would be saved to DB and then prepended again on next restart, duplicating with each cycle. Extracting only between markers ensures clean round-tripping.

**Trade-off:** If an agent adds lines *after* the end marker (e.g., appending to the file), those additions won't be persisted. The SOUL.md "Growth Mindset" directives should instruct agents to edit between the markers or use the `update-profile` MCP tool.

#### 3. PostToolUse Hook for Edits
**File**: `src/hooks/hook.ts`
**Changes**: In the PostToolUse handler (~line 537), alongside the existing identity file sync detection, add detection for setup script and TOOLS.md edits:

```typescript
if (
  (toolName === "Write" || toolName === "Edit") &&
  editedPath &&
  editedPath.startsWith("/workspace/start-up")
) {
  try {
    await syncSetupScriptToServer(agentInfo.id);
  } catch { /* non-blocking */ }
}

// TOOLS.md edits are handled by the extended syncIdentityFilesToServer
// which already triggers on identity file edits. Add TOOLS.md path detection:
if (
  (toolName === "Write" || toolName === "Edit") &&
  editedPath === "/workspace/TOOLS.md"
) {
  try {
    await syncIdentityFilesToServer(agentInfo.id);
  } catch { /* non-blocking */ }
}
```

This catches edits to any `/workspace/start-up.*` variant and `/workspace/TOOLS.md`.

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] Existing tests pass: `bun test` (325 pass, 0 fail)

#### Manual Verification:
- [x] Set agent's setupScript, start Docker worker — `/workspace/start-up.sh` created with correct content
- [x] Verify `/workspace/TOOLS.md` exists with default template (Repos, Services, Infrastructure sections)
- [x] Edit `/workspace/start-up.sh` during Claude session — PostToolUse hook synced `pip3 install httpx` to DB
- [x] Edit `/workspace/TOOLS.md` during Claude session — PostToolUse hook synced `API server at localhost:3013` to DB
- [x] Stop hook syncs both files to DB (verified via task completion + DB query)
- [x] Restart container — updated script runs and TOOLS.md restored from DB

**Implementation Note**: After completing this phase, pause for manual confirmation. Docker testing required.

---

## Phase 5: Self-Improvement Directives + TOOLS.md Template

### Overview
Update the SOUL.md template and base prompt to include explicit self-improvement guidance about setup scripts, TOOLS.md, and environment evolution. Add a `generateDefaultToolsMd()` template inspired by [OpenClaw's TOOLS.md pattern](https://github.com/openclaw/openclaw/blob/main/docs/reference/templates/TOOLS.md) — a structured personal reference for environment-specific operational knowledge.

### Changes Required:

#### 1. `generateDefaultToolsMd()` Template
**File**: `src/be/db.ts`
**Changes**: Add a new function after `generateDefaultIdentityMd()` (~line 2317):

```typescript
export function generateDefaultToolsMd(agent: {
  name: string;
  role?: string;
}): string {
  return `# TOOLS.md — ${agent.name}

Skills define *how* tools work. This file is for *your* specifics.

## What Goes Here

Environment-specific knowledge that's unique to your setup:
- Repos you work with and their conventions
- Services, ports, and endpoints you interact with
- SSH hosts and access patterns
- API keys and auth patterns (references, not secrets)
- CLI tools and their quirks
- Anything that makes your job easier to remember

## Repos

<!-- Add repos you work with: name, path, conventions, gotchas -->

## Services

<!-- Add services you interact with: name, port, health check, notes -->

## Infrastructure

<!-- SSH hosts, Docker registries, cloud resources -->

## APIs & Integrations

<!-- Endpoints, auth patterns, rate limits -->

## Tools & Shortcuts

<!-- CLI aliases, scripts, preferred tools for specific tasks -->

## Notes

<!-- Anything else environment-specific -->

---
*This file is yours. Update it as you discover your environment. Changes persist across sessions.*
`;
}
```

**Key design principle** (from [OpenClaw](https://github.com/openclaw/openclaw/blob/main/docs/reference/templates/TOOLS.md)): "Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure."

#### 2. Runner Default Generation
**File**: `src/commands/runner.ts`
**Changes**: In the default generation fallback section (~line 1553-1586), alongside the existing `generateDefaultSoulMd()` and `generateDefaultIdentityMd()` calls, also generate default TOOLS.md:

```typescript
if (!agentToolsMd) {
  agentToolsMd = generateDefaultToolsMd({ name: agentProfileName || role, role });
  // Push default to server
  await fetch(`${apiUrl}/api/agents/${agentId}/profile`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ toolsMd: agentToolsMd }),
  });
}
```

#### 3. SOUL.md Template Update
**File**: `src/be/db.ts` — `generateDefaultSoulMd()` (~line 2240)
**Changes**: Add a new section after `## Boundaries` and before `## Self-Evolution`:

```markdown
## Growth Mindset

After completing tasks, reflect on what made them harder or easier:
- **Tools you wished you had?** Add them to your setup script (\`/workspace/start-up.sh\`).
  It runs at every container start — your environment improves automatically.
  Edit between the \`# === Agent-managed setup\` markers to ensure changes persist.
  Or use the \`update-profile\` tool with the \`setupScript\` field.
- **Environment knowledge gained?** Record it in your TOOLS.md — repos, services, APIs, infra.
- **Patterns you discovered?** Record them in your CLAUDE.md notes.
- **Mistakes you want to avoid?** Add guardrails to your setup script or notes.

Your setup script and TOOLS.md are yours to evolve. Start small and iterate.
```

Update the `## Self-Evolution` section to reference all self-evolving artifacts:

```markdown
## Self-Evolution

These files are yours. As you work and learn, refine them:
- **This file (SOUL.md)** — Your persona and values
- **IDENTITY.md** — Your expertise and working style
- **TOOLS.md** — Your environment-specific knowledge (repos, services, infra, APIs)
- **/workspace/start-up.sh** — Your environment setup (tools, configs, aliases)
- **CLAUDE.md** — Your operational notes and learnings

Changes to all of these persist across sessions.
```

#### 4. Base Prompt Filesystem Section Update
**File**: `src/prompts/base-prompt.ts` — `BASE_PROMPT_FILESYSTEM` (~line 204)
**Changes**: Add mentions of the setup script and TOOLS.md after the existing filesystem description:

```markdown
### Environment Setup
Your setup script at \`/workspace/start-up.sh\` runs at every container start.
Use it to install tools, configure your environment, or set up workflows.
If the file has \`# === Agent-managed setup\` markers, edit between them — content
between markers is what persists to the database. You can also use the \`update-profile\`
tool with the \`setupScript\` field.

### Operational Knowledge
Your \`/workspace/TOOLS.md\` file stores environment-specific knowledge — repos you work with,
services and ports, SSH hosts, APIs, tool preferences. Update it as you learn about your environment.
It persists across sessions.
```

**Design decision — TOOLS.md is NOT injected into the system prompt.** Unlike SOUL.md and IDENTITY.md (which are injected via `getBasePrompt()` at `base-prompt.ts:289-298`), TOOLS.md is a reference file the agent reads on demand via the `Read` tool. Rationale: TOOLS.md can grow large with operational details (repo lists, service inventories, API endpoints), and injecting it into every system prompt would waste tokens. Agents are told about its existence in the filesystem section and can read it when the task requires environment knowledge. The `BasePromptArgs` type does NOT get a `toolsMd` parameter.

#### 5. Updated Default CLAUDE.md Template
**File**: `src/be/db.ts` — `generateDefaultClaudeMd()` (~line 2200)
**Changes**: Add mentions of the setup script and TOOLS.md in the "Your Identity Files" section:

```markdown
- **`/workspace/TOOLS.md`** — Your environment-specific knowledge (repos, services, APIs, infra)
- **`/workspace/start-up.sh`** — Your setup script (runs at container start, add tools/configs here)
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] Existing tests pass: `bun test` (325 pass, 0 fail)

#### Manual Verification:
- [x] Register a new agent — verify SOUL.md includes "Growth Mindset" section
- [x] Verify TOOLS.md is generated with structured categories (Repos, Services, Infrastructure, etc.)
- [x] Verify base prompt includes "Environment Setup" and "Operational Knowledge" sections
- [x] Verify CLAUDE.md template references both `/workspace/TOOLS.md` and `/workspace/start-up.sh`

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Testing Strategy

### Automated Tests
- `bun run tsc:check` — Type checking after each phase
- `bun run lint:fix` — Lint after each phase
- `bun test` — All existing tests pass (no regressions)

### Unit Tests (new file: `src/tests/setup-script.test.ts`)
- Migration: `setupScript` and `toolsMd` columns exist after `initDb()`
- `updateAgentProfile` with `setupScript` — persists and returns
- `updateAgentProfile` with `toolsMd` — persists and returns
- `getAgentById` returns `setupScript` and `toolsMd` fields
- `GET /api/agents/:id/setup-script` returns both agent and global scripts
- Global script from `swarm_config` with key `SETUP_SCRIPT` is returned
- `generateDefaultToolsMd()` returns structured template with expected sections

### What's NOT Tested Automatically
- Docker entrypoint script composition (requires Docker container)
- Stop hook sync for setup script + TOOLS.md (requires real Claude session)
- PostToolUse hook detection for both file types (requires real Claude session)
- These are tested manually via the E2E section below.

---

## Manual E2E Verification

```bash
# 1. Start server
bun run start:http

# 2. Register an agent (or use existing)
AGENT_ID="<agent-id>"

# 3. Set per-agent setup script
curl -X PUT -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d '{"setupScript":"echo \"Agent setup ran at $(date)\" > /tmp/agent-setup-test\napt-get update -qq && apt-get install -y -qq jq > /dev/null 2>&1 || true"}' \
  http://localhost:3013/api/agents/$AGENT_ID/profile | jq '.setupScript'

# 4. Set global setup script via swarm_config
curl -X PUT -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d '{"scope":"global","key":"SETUP_SCRIPT","value":"echo \"Global setup ran\" > /tmp/global-setup-test"}' \
  http://localhost:3013/api/config | jq .

# 5. Verify fetch endpoint
curl -H "Authorization: Bearer 123123" \
  -H "X-Agent-ID: $AGENT_ID" \
  http://localhost:3013/api/agents/$AGENT_ID/setup-script | jq .
# Should show both setupScript and globalSetupScript

# 6. Build and start Docker worker
bun run docker:build:worker
# Start worker container pointing at API

# 7. Verify scripts ran
docker exec <container> cat /tmp/global-setup-test   # "Global setup ran"
docker exec <container> cat /tmp/agent-setup-test     # "Agent setup ran at ..."
docker exec <container> which jq                       # Should show jq path

# 8. Create a task that edits the setup script
curl -X POST -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d "{\"task\":\"Add 'pip install requests' to your setup script at /workspace/start-up.sh\",\"agentId\":\"$AGENT_ID\"}" \
  http://localhost:3013/api/tasks | jq .

# 9. After task completes, verify DB was updated
curl -H "Authorization: Bearer 123123" \
  http://localhost:3013/api/agents/$AGENT_ID/setup-script | jq '.setupScript'
# Should include the pip install line

# 10. Restart worker, verify updated script runs
docker restart <container>
docker exec <container> python3 -c "import requests; print(requests.__version__)"

# --- TOOLS.md lifecycle ---

# 11. Verify TOOLS.md was generated with default template
docker exec <container> cat /workspace/TOOLS.md
# Should have structured sections: Repos, Services, Infrastructure, APIs, Tools & Shortcuts

# 12. Set TOOLS.md via API
curl -X PUT -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d '{"toolsMd":"# TOOLS.md\n\n## Repos\n- agent-swarm → /workspace/shared, Bun + TypeScript\n\n## Services\n- API → localhost:3013\n"}' \
  http://localhost:3013/api/agents/$AGENT_ID/profile | jq '.toolsMd'

# 13. Restart worker, verify TOOLS.md is restored from DB
docker restart <container>
docker exec <container> cat /workspace/TOOLS.md
# Should show the content set in step 12

# 14. Create a task that edits TOOLS.md
curl -X POST -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d "{\"task\":\"Add a note about Redis on port 6379 to your /workspace/TOOLS.md under Services\",\"agentId\":\"$AGENT_ID\"}" \
  http://localhost:3013/api/tasks | jq .

# 15. After task completes, verify DB was updated with TOOLS.md changes
curl -H "Authorization: Bearer 123123" \
  http://localhost:3013/api/agents/$AGENT_ID | jq '.toolsMd'
# Should include the Redis note
```

## References

- Research: `thoughts/taras/research/2026-02-19-swarm-gaps-implementation.md` (Gap 5 section, lines 304-331)
- Base research: `thoughts/taras/research/2026-02-19-agent-native-swarm-architecture.md`
- Identity implementation: `thoughts/taras/plans/2026-02-20-worker-identity.md` (pattern for file lifecycle)
- Env management: `thoughts/taras/plans/2026-02-20-env-management.md` (swarm_config table)
- TOOLS.md inspiration: [OpenClaw TOOLS.md template](https://github.com/openclaw/openclaw/blob/main/docs/reference/templates/TOOLS.md) (environment-specific reference pattern)
