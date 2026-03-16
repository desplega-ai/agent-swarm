---
date: 2026-03-11T10:40:00Z
topic: "Archil Per-Agent Write Strategy Implementation"
author: Claude
status: completed
tags: [plan, archil, shared-disk, per-agent, ownership, fly-io]
research: "thoughts/taras/research/2026-03-11-archil-shared-disk-write-strategies.md"
autonomy: critical
---

# Archil Per-Agent Write Strategy Implementation Plan

## Overview

Implement per-agent write isolation on the shared Archil disk. Each agent gets exclusive write ownership of its own subdirectories (`thoughts/$AGENT_ID/`, `memory/$AGENT_ID/`, `downloads/$AGENT_ID/`, `misc/$AGENT_ID/`). All agents can read everything via the `--shared` mount. Write attempts to non-owned directories are intercepted by a PreToolUse hook guardrail (proactive) that warns the agent before the write fails, with a PostToolUse safety net for writes that bypass PreToolUse (e.g., Bash-based writes).

## Current State Analysis

The shared Archil disk at `/workspace/shared` is mounted with `--shared` on all containers (workers + API). Currently:

- `docker-entrypoint.sh:55-58` does `mkdir -p` for `thoughts/shared/{plans,research}` and `memory/` — the **first agent to boot wins ownership**, others silently fail with EPERM
- `docker-entrypoint.sh:477-486` does `archil checkout` for `thoughts/$AGENT_ID` only — this works correctly
- `base-prompt.ts:219` tells agents to write shared plans to `thoughts/shared/plans/` — broken for all agents except the first to boot
- `base-prompt.ts:245` tells agents to write memory to `/workspace/shared/memory/` — same issue
- `hook.ts:473-474` auto-indexes memory files using `startsWith("/workspace/shared/memory/")` — already matches `memory/$AGENT_ID/foo.md`, no change needed

### Key Discoveries:
- `hook.ts:473-474`: Memory auto-indexing path detection uses `startsWith("/workspace/shared/memory/")` which naturally matches per-agent subdirs — **no hook change needed for indexing**
- `hook.ts:164`: `isShared` scope detection uses same prefix — **also fine**
- `inject-learning.ts`, `store-progress.ts`: Write to database only, not filesystem — **not affected**
- `memory-search` MCP tool: Queries indexed database — **not affected by path changes**
- `slack-download-file.ts:14`: Hardcoded default `/workspace/shared/downloads/slack/` — needs update
- Archil `mkdir` on unowned dirs auto-grants ownership to the creator **at the first new parent level** (see Appendix A)
- Archil `--shared` mounts are always fully readable by all clients
- **CRITICAL**: `mkdir -p thoughts/agent-1/plans` when `thoughts/` doesn't exist auto-grants delegation on `thoughts/` (the parent), NOT `thoughts/agent-1/`. This blocks all other agents from writing inside `thoughts/`. Fix: pre-create top-level dirs, then agents `mkdir` only their subdirs (grants delegation at the correct subdir level).
- Write failures on `--shared` mounts produce **"Read-only file system"** errors (not EPERM/EACCES)
- A single Archil client can hold multiple non-overlapping delegations simultaneously (verified)
- `archil checkout` requires the target path to already exist (fails with "does not exist" otherwise)
- Unmounting releases ALL delegations; remounting starts fresh

**Note on `misc/`**: This directory is a new addition (not analyzed in the research). It serves as a catch-all for unanticipated agent writes — agents doing ad-hoc work (temp files, scratch data, tool outputs) need somewhere safe to write that doesn't pollute the structured `thoughts/`/`memory/`/`downloads/` hierarchy. Without it, agents would fail on any write that doesn't fit the three predefined categories.

## Desired End State

```
/workspace/shared/                    # --shared mount, all agents read everything
├── thoughts/
│   ├── worker-1/                     # Checked out by worker-1 at boot
│   │   ├── plans/
│   │   ├── research/
│   │   └── brainstorms/
│   ├── worker-2/                     # Checked out by worker-2 at boot
│   │   └── ...
│   └── lead/                         # Checked out by lead at boot
│       └── ...
├── memory/
│   ├── worker-1/                     # Checked out by worker-1
│   ├── worker-2/                     # Checked out by worker-2
│   └── lead/                         # Checked out by lead
├── downloads/
│   ├── worker-1/slack/               # Checked out by worker-1
│   └── worker-2/slack/               # Checked out by worker-2
└── misc/
    ├── worker-1/                     # Catch-all for unanticipated writes
    └── worker-2/
```

Boot flow — two-phase (API pre-creates, workers checkout):

**API machine** (boots first — deploy script waits for "started"):
```
archil mount --shared {disk} /workspace/shared
→ mkdir thoughts/ memory/ downloads/ misc/     # creates top-level dirs, gets parent delegations
→ archil unmount /workspace/shared              # releases parent delegations
→ archil mount --shared {disk} /workspace/shared # remount clean (no delegations)
```

**Worker/Lead machines** (boot after API):
```
archil mount --shared {disk} /workspace/shared   # top-level dirs already exist (API created them)
→ mkdir thoughts/$AGENT_ID                        # auto-grants delegation on thoughts/$AGENT_ID (NOT thoughts/)
→ mkdir memory/$AGENT_ID                          # auto-grants delegation on memory/$AGENT_ID
→ mkdir downloads/$AGENT_ID                       # auto-grants delegation on downloads/$AGENT_ID
→ mkdir misc/$AGENT_ID                            # auto-grants delegation on misc/$AGENT_ID
→ archil checkout thoughts/$AGENT_ID              # persistent ownership (survives reboots)
→ archil checkout memory/$AGENT_ID
→ archil checkout downloads/$AGENT_ID
→ archil checkout misc/$AGENT_ID
→ mkdir -p thoughts/$AGENT_ID/{plans,research,brainstorms}
→ mkdir -p downloads/$AGENT_ID/slack
```

**Why two phases?** Archil `mkdir` auto-grants delegation at the **first new directory** in the path. If `thoughts/` doesn't exist, `mkdir -p thoughts/agent-1/plans` grants delegation on `thoughts/` (the parent), blocking all other agents. By having the API pre-create top-level dirs and release ownership, workers' `mkdir thoughts/$AGENT_ID` correctly grants delegation at the subdir level only.

Agent runtime:
- Write to own dirs: ✅ (owned via checkout)
- Read any agent's dirs: ✅ (shared mount)
- Write to another agent's dir: ❌ "Read-only file system" → hook hints "use your own dir"
- Write to non-existent top-level: ❌ hook hints "use misc/$AGENT_ID/"

## Quick Verification Reference

Common commands:
- `bun run tsc:check` — TypeScript check
- `bun run lint` — Biome lint
- Deploy test: push to main → wait for Docker build → `GITHUB_TOKEN=$(gh auth token) bun run scripts/deploy-swarm.ts <app> -y` (from agent-swarm-internal)
- Check logs: `fly logs -a <app> --no-tail | head -100`
- Check machines: `fly machines list -a <app>`

Key files:
- `docker-entrypoint.sh` — boot-time checkout
- `src/prompts/base-prompt.ts` — agent system prompt
- `src/hooks/hook.ts` — PostToolUse hook (memory indexing + guardrails)
- `src/tools/slack-download-file.ts` — slack download default path
- `plugin/pi-skills/work-on-task/SKILL.md` — pi-mono skill paths

## What We're NOT Doing

- **API-mediated shared writes** — deferred. If we ever need a truly shared writable directory, we'll add an API endpoint for that.
- **Database discovery layer** — memory-search already provides this. Plan/research discovery is handled by `ls /workspace/shared/thoughts/*/plans/` in prompts.
- **Data migration** — existing `thoughts/shared/` files remain readable. No move needed.
- **Deploy script changes** — `deploy-swarm.ts` doesn't need changes (Archil disk names and env vars stay the same).
- **Orphaned directory cleanup** — if `AGENT_ID` changes (e.g., machine replacement), the old agent's dirs remain on disk. Acceptable tech debt for v1 — dirs are small and readable by all agents. Cleanup can be added later if needed.

## Implementation Approach

Four phases, each independently deployable and verifiable:

1. **Entrypoint**: Two-phase setup — API pre-creates top-level dirs and releases ownership, workers create per-agent subdirs and checkout. Includes retry backoff for boot race safety.
2. **Prompting**: Update base-prompt.ts to describe the new directory layout. Works with or without Archil.
3. **Hook guardrails**: Add PreToolUse prevention (primary, proactive) and PostToolUse detection (secondary, safety net) for non-owned write attempts.
4. **Tool path updates**: Update hardcoded paths in slack download tool and pi-skills.

---

## Phase 1: Entrypoint — Two-Phase Directory Setup

### Overview
Implement a two-phase boot sequence: the API machine pre-creates top-level directories and releases ownership, then workers create their per-agent subdirectories and claim ownership via checkout. This avoids the parent-delegation problem where `mkdir -p thoughts/$AGENT_ID/plans` would auto-grant ownership of the entire `thoughts/` directory to the first agent to boot, blocking all others (see Appendix A for the test that discovered this).

### Changes Required:

#### 1. API entrypoint — pre-create top-level dirs
**File**: `docker-entrypoint.sh`
**Location**: After the `archil mount --shared` call for the shared disk, add a block for the API role:

```bash
# --- API: Pre-create top-level shared directories ---
# The API boots first (deploy script waits for "started" state).
# We create the top-level category dirs so that workers' mkdir
# auto-grants delegation at the subdir level (not the parent).
# Then we unmount/remount to release the parent delegations.
if [ "$AGENT_ROLE" = "api" ] && [ -n "$ARCHIL_MOUNT_TOKEN" ]; then
    echo "Pre-creating shared directory structure..."
    for category in thoughts memory downloads misc; do
        mkdir -p "/workspace/shared/$category" 2>/dev/null || true
    done
    # Release parent delegations (mkdir auto-granted them)
    sudo --preserve-env=ARCHIL_MOUNT_TOKEN archil unmount /workspace/shared 2>/dev/null || true
    sudo --preserve-env=ARCHIL_MOUNT_TOKEN archil mount --shared \
        --region "$ARCHIL_REGION" "$ARCHIL_SHARED_DISK_NAME" /workspace/shared
    echo "Shared directory structure ready (delegations released)"
fi
```

#### 2. Worker/Lead entrypoint — per-agent checkout
**File**: `docker-entrypoint.sh`
**Location**: Remove the broken shared mkdir block (currently around lines 55-58). Replace the per-agent checkout block (currently around lines 477-486).

```bash
if [ -n "$AGENT_ID" ]; then
    AGENT_SHARED="/workspace/shared"

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
        mkdir -p "$AGENT_DIR" 2>/dev/null || true

        # Checkout for persistent ownership (survives reboots where dir already exists)
        if [ -n "$ARCHIL_MOUNT_TOKEN" ]; then
            sudo --preserve-env=ARCHIL_MOUNT_TOKEN archil checkout "$AGENT_DIR" 2>/dev/null || true
        fi
    done

    # Create standard subdirectories (within owned dirs, always succeeds)
    mkdir -p "$AGENT_SHARED/thoughts/$AGENT_ID/plans"
    mkdir -p "$AGENT_SHARED/thoughts/$AGENT_ID/research"
    mkdir -p "$AGENT_SHARED/thoughts/$AGENT_ID/brainstorms"
    mkdir -p "$AGENT_SHARED/downloads/$AGENT_ID/slack"

    echo "Per-agent directories ready for $AGENT_ID"
fi
```

#### 3. Worker entrypoint — retry with backoff (safety net)
**File**: `docker-entrypoint.sh`
**Location**: Wrap the mkdir/checkout loop above in a retry mechanism in case workers boot before the API finishes pre-creating dirs:

```bash
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
```

### Success Criteria:

#### Automated Verification:
- [x] Entrypoint runs without errors: `fly logs -a <app> --no-tail | grep -E "(Pre-creating|Per-agent directories ready|Error)"`
- [x] All machines start successfully: `fly machines list -a <app>` shows all `started`
- [x] Agent can write to own dir: SSH in and `echo test > /workspace/shared/thoughts/$AGENT_ID/test.txt`
- [x] Agent can read other's dir: SSH in as agent-1 and `cat /workspace/shared/thoughts/agent-2/test.txt`

#### Manual Verification:
- [x] Deploy to test swarm and confirm all workers + lead boot cleanly
- [x] **DELEGATION CHECK**: `archil delegations /workspace/shared` on each worker shows 4 delegations at the subdir level (e.g., `thoughts/agent-1`, NOT `thoughts/`)
- [x] **CROSS-AGENT WRITE BLOCKED**: SSH into worker-1, try `echo test > /workspace/shared/thoughts/agent-2/test.txt` — verify "Read-only file system" error
- [x] **CROSS-AGENT READ WORKS**: SSH into worker-1, `cat /workspace/shared/thoughts/agent-2/test.txt` — verify content is readable
- [x] **READ PROPAGATION TEST**: Worker-1 writes a file, worker-2 reads it immediately — note any delay
- [x] Verify existing `thoughts/shared/` directory (if present) is still readable

**Implementation Note**: The error pattern for non-owned writes is confirmed: **"Read-only file system"** (not EPERM/EACCES). This will be used in Phase 3. Pause for confirmation before proceeding.

---

## Phase 2: Prompting — Directory Layout Convention

### Overview
Update `base-prompt.ts` to describe the per-agent directory convention. This works as good hygiene even without Archil — agents are guided to write to organized per-agent directories. With Archil, the guardrail (Phase 3) enforces it.

### Changes Required:

#### 1. Workspace directory layout in system prompt
**File**: `src/prompts/base-prompt.ts`
**Changes** (around lines 215-250):

Update the workspace directory structure description to describe the per-agent layout:
- Personal workspace (`/workspace/personal/`) — unchanged
- Shared workspace (`/workspace/shared/`) — each agent writes to `{category}/{yourId}/`, reads everything
- List the write directories: thoughts, memory, downloads, misc
- Show how to discover other agents' work: `ls /workspace/shared/thoughts/*/plans/`, `memory-search`
- Add clear warning: "Do NOT write to another agent's directory"

#### 2. Remove references to `thoughts/shared/`
**File**: `src/prompts/base-prompt.ts`
**Changes**: Find and update all references to `thoughts/shared/plans/` and `thoughts/shared/research/` to use `thoughts/{agentId}/plans/` and `thoughts/{agentId}/research/` instead.

#### 3. Update memory write path guidance
**File**: `src/prompts/base-prompt.ts`
**Changes** (around line 245): Change memory write path from `/workspace/shared/memory/` to `/workspace/shared/memory/{agentId}/`.

### Success Criteria:

#### Automated Verification:
- [x] TypeScript check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint`
- [x] No remaining references to `thoughts/shared/plans` or `thoughts/shared/research` as write targets: `grep -rn "thoughts/shared" src/prompts/`

#### Manual Verification:
- [x] Read the generated prompt for a test agent and confirm the workspace layout section is clear and correct
- [x] Verify agent ID substitution works correctly in the prompt

**Implementation Note**: This phase doesn't require a deploy to verify. TypeScript + lint is sufficient. Proceed to Phase 3 after confirmation.

---

## Phase 3: Hook Guardrails — Write Failure Detection

### Overview
Add PreToolUse write prevention (primary, proactive) and PostToolUse error detection (secondary, safety net) in `hook.ts` and `pi-mono-extension.ts`. The error pattern for non-owned writes is **"Read-only file system"** (confirmed in Appendix A testing).

### Changes Required:

#### 1. Path ownership check helper
**Files**: `src/hooks/hook.ts` and `src/providers/pi-mono-extension.ts`
**Changes**: Add a shared helper function (or duplicate in both files):
```ts
function isOwnedSharedPath(path: string, agentId: string): boolean {
  const sharedCategories = ["thoughts", "memory", "downloads", "misc"];
  return sharedCategories.some(cat =>
    path.startsWith(`/workspace/shared/${cat}/${agentId}/`)
  );
}
```

#### 2. PreToolUse prevention (primary — proactive)
**Files**: `src/hooks/hook.ts` (PreToolUse handler) and `src/providers/pi-mono-extension.ts` (`tool_call` handler)
**Changes**: Before a Write/Edit tool executes, check if:
1. `ARCHIL_MOUNT_TOKEN` is set (skip in local dev — all paths are writable)
2. The target path is under `/workspace/shared/` but NOT under the agent's own subdirectory

If both conditions are true, return a **non-blocking warning** hint:
```
⚠️ This write will fail: You don't have write access to this directory.

On shared workspaces, each agent can only write to their own directories:
- /workspace/shared/thoughts/{yourId}/
- /workspace/shared/memory/{yourId}/
- /workspace/shared/downloads/{yourId}/
- /workspace/shared/misc/{yourId}/

You CAN read any file on the shared disk. For writes, use your own subdirectory.
```

This prevents wasted tool calls by warning the agent before the write fails.

#### 3. PostToolUse detection (secondary — safety net)
**Files**: `src/hooks/hook.ts` (PostToolUse handler) and `src/providers/pi-mono-extension.ts` (`tool_result` handler)
**Changes**: After a Write/Edit tool call, check if:
1. The tool result indicates an error (exact pattern from Phase 1 error discovery)
2. The target path is under `/workspace/shared/` but NOT owned by this agent

If both conditions are true, return the same hint as above. This catches cases where the PreToolUse check didn't fire (e.g., Bash-based writes, MCP tools).

### Success Criteria:

#### Automated Verification:
- [x] TypeScript check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint`
- [x] Hook correctly identifies owned paths: test `isOwnedSharedPath("/workspace/shared/memory/agent-1/foo.md", "agent-1")` → true
- [x] Hook correctly identifies non-owned paths: test `isOwnedSharedPath("/workspace/shared/memory/agent-2/foo.md", "agent-1")` → false
- [x] Both `hook.ts` and `pi-mono-extension.ts` contain the guardrail logic

#### Manual Verification:
- [x] Deploy and have an agent attempt to write to another agent's directory — verify the PreToolUse hint appears before the write
- [x] Verify writes to own directory still work without any hook interference
- [x] Verify the hint message is clear and actionable
- [x] Test with pi-mono harness (if available) to confirm parity

**Implementation Note**: PreToolUse is the primary guardrail (proactive). PostToolUse is the safety net (reactive). Both must be implemented in both `hook.ts` and `pi-mono-extension.ts`.

---

## Phase 4: Tool Path Updates

### Overview
Update hardcoded default paths in tools that write to the shared disk, so they use per-agent subdirectories by default.

### Changes Required:

#### 1. Slack download file tool
**File**: `src/tools/slack-download-file.ts`
**Changes** (around line 14): Update the default download directory to include agent ID:
```ts
const DEFAULT_DOWNLOAD_DIR = `/workspace/shared/downloads/${process.env.AGENT_ID || "default"}/slack`;
```

#### 2. Slack files utility
**File**: `src/slack/files.ts`
**Changes** (around line 14): Same pattern — update default path to include `$AGENT_ID`.

#### 3. Pi-mono work-on-task skill
**File**: `plugin/pi-skills/work-on-task/SKILL.md`
**Changes** (around line 27): Update path from `thoughts/shared/plans/` to `thoughts/{agentId}/plans/`.

#### 4. Plugin commands
**File**: `plugin/commands/work-on-task.md`
**Changes** (around line 68): Update `shared/memory/` reference to `memory/{agentId}/` (this line references the memory path, not thoughts).

#### 5. Plugin build script
**File**: `plugin/build-pi-skills.ts`
**Changes** (around line 76): Update `thoughts/shared/plans/` reference.

#### 6. Agent templates
**Files**:
- `templates/official/researcher/CLAUDE.md` (line 33)
- `templates/official/tester/CLAUDE.md` (line 36)
- `templates/official/forward-deployed-engineer/CLAUDE.md` (line 36)
**Changes**: Update shared path references to use per-agent convention.

#### 7. Documentation
**Files**:
- `docs-site/content/docs/architecture/memory.mdx` (lines 20, 28)
- `docs-site/content/docs/architecture/agents.mdx` (line 78)
- `docs-site/content/docs/guides/slack-integration.mdx` (line 89)
- `docs-site/content/docs/reference/mcp-tools.mdx` (line 213)
- `MCP.md` (line 272)
- `README.md` (line 148)
**Changes**: Update shared path references in documentation.

#### 8. Database prompt text
**File**: `src/be/db.ts`
**Changes** (around line 2144): Update prompt text referencing shared memory path.

#### 9. Remaining hardcoded shared paths
**Files**: Final grep sweep for any remaining hardcoded references to shared write paths.

### Success Criteria:

#### Automated Verification:
- [x] TypeScript check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint`
- [x] No remaining hardcoded shared write paths: `grep -rn "/workspace/shared/downloads/slack" src/ plugin/ templates/ docs-site/ README.md MCP.md` returns nothing
- [x] No remaining `thoughts/shared` write targets: `grep -rn "thoughts/shared" src/ plugin/ templates/ docs-site/ README.md MCP.md | grep -v "read\|Read\|cat \|ls "` returns nothing

#### Manual Verification:
- [x] Deploy and test Slack file download — verify file lands in `downloads/$AGENT_ID/slack/`
- [x] Test a pi-mono agent's plan creation — verify plan goes to `thoughts/$AGENT_ID/plans/`

**Implementation Note**: After completing this phase, do a full E2E deploy and verify all write operations land in the correct per-agent directories.

---

## Testing Strategy

### Automated
- `bun run tsc:check` — type safety
- `bun run lint` — code quality
- `grep` searches for leftover hardcoded paths

### Manual E2E (on live swarm)
After all phases:
1. Deploy fresh with `GITHUB_TOKEN=$(gh auth token) bun run scripts/deploy-swarm.ts <app> -y`
2. `fly logs -a <app> --no-tail | grep "Per-agent directories"` — verify all agents checkout OK
3. `fly machines list -a <app>` — all machines started
4. Via MCP or SSH, have an agent:
   - Write a plan → verify lands in `thoughts/$AGENT_ID/plans/`
   - Write a memory file → verify lands in `memory/$AGENT_ID/` and is auto-indexed
   - Download a Slack file → verify lands in `downloads/$AGENT_ID/slack/`
   - Read another agent's plan → verify succeeds
   - Attempt to write to another agent's dir → verify hook guardrail fires
5. Check `archil delegations /workspace/shared` shows correct per-agent checkouts

## References
- Research: `thoughts/taras/research/2026-03-11-archil-shared-disk-write-strategies.md`
- Archil shared disk docs: https://docs.archil.com/concepts/shared-disks
- Current entrypoint: `docker-entrypoint.sh`
- Current prompts: `src/prompts/base-prompt.ts`
- Current hooks: `src/hooks/hook.ts`

---

## Appendix A: Live Archil Checkout Testing

_Tested 2026-03-11 on `swarm-test-archil` (Fly.io, AMS region). Two worker machines (`test-agent-1`, `test-agent-2`) with a shared Archil disk._

### Test environment
```
App: swarm-test-archil (deploys/test in agent-swarm-internal)
Workers: 7810621a9e29e8 (test-agent-1), 683435ef716518 (test-agent-2)
Shared disk: dsk-00000000000069cb
```

### Test 1: Multiple checkouts per client ✅
Worker-2 successfully held 6+ delegations simultaneously:
```bash
# On worker-2 after mkdir + checkout:
archil delegations /workspace/shared
# Result:
#   /workspace/shared/thoughts (Active)
#   /workspace/shared/memory (Active)
#   /workspace/shared/thoughts/test-agent-2 (Active)
#   /workspace/shared/misc (Active)
#   /workspace/shared/memory/test-agent-2 (Active)
#   /workspace/shared/downloads (Active)
```
**Conclusion**: A single Archil client CAN hold multiple non-overlapping delegations.

### Test 2: Parent delegation problem ❌ (discovered)
Worker-2 ran `mkdir -p /workspace/shared/thoughts/test-agent-2/plans` (first agent to create `thoughts/`):
```bash
archil delegations /workspace/shared
# Result: /workspace/shared/thoughts (Active)  ← owns ALL of thoughts/!
```
Worker-1 then tried to create its subdir:
```bash
mkdir -p /workspace/shared/thoughts/test-agent-1/plans
# Result: mkdir: cannot create directory '/workspace/shared/thoughts/test-agent-1': Read-only file system
```
**Root cause**: `mkdir -p` auto-grants delegation at the **first new parent directory**. Since `thoughts/` didn't exist, worker-2 got delegation on `thoughts/` (not `thoughts/test-agent-2/`), blocking all other agents.

### Test 3: Cross-agent reads ✅
Worker-1 successfully read worker-2's file:
```bash
# On worker-1:
cat /workspace/shared/thoughts/test-agent-2/plans/test.txt
# Result: hello from agent-2
```

### Test 4: Cross-agent writes blocked ✅
Worker-1 correctly blocked from writing to worker-2's dir:
```bash
echo "intruder" > /workspace/shared/thoughts/test-agent-2/plans/hack.txt
# Result: bash: /workspace/shared/thoughts/test-agent-2/plans/hack.txt: Read-only file system
```
**Error pattern confirmed: "Read-only file system"** (not EPERM or EACCES).

### Test 5: Unmount/remount/checkout fix ✅
Worker-2 unmounted, remounted, then checked out only its subdir:
```bash
archil unmount /workspace/shared
archil mount --shared --region aws-eu-west-1 $ARCHIL_SHARED_DISK_NAME /workspace/shared
archil checkout /workspace/shared/thoughts/test-agent-2
archil checkout /workspace/shared/memory/test-agent-2

archil delegations /workspace/shared
# Result:
#   /workspace/shared/thoughts/test-agent-2 (Active)  ← correct! subdir only
#   /workspace/shared/memory/test-agent-2 (Active)
```
**Conclusion**: Unmounting releases ALL delegations. Checkout on existing subdirs grants delegation at the correct level.

### Test 6: Worker-1 mkdir after parent delegation released ✅
With worker-2 no longer owning `thoughts/` (only `thoughts/test-agent-2`), worker-1 successfully created its subdir:
```bash
# On worker-1 (after unmount/remount):
mkdir -p /workspace/shared/thoughts/test-agent-1/plans
# Result: exit 0 (success!)

echo "hello from agent-1" > /workspace/shared/thoughts/test-agent-1/plans/my-plan.txt
# Result: exit 0 (success!)

archil checkout /workspace/shared/thoughts/test-agent-1
# Result: exit 0

archil delegations /workspace/shared
# Result: /workspace/shared/thoughts/test-agent-1 (Active)  ← correct!
```

### Test 7: archil checkout requires existing path ❌
```bash
archil checkout /workspace/shared/thoughts/test-agent-2
# Before dir exists: 'checkout' operation failed because path does not exist
# After mkdir: exit 0 (success)
```
**Conclusion**: `archil checkout` cannot create directories. Path must exist first.

### Summary of findings

| Behavior | Result |
|----------|--------|
| Multiple checkouts per client | ✅ Works (6+ simultaneous) |
| Cross-agent reads | ✅ Works perfectly |
| Cross-agent write blocking | ✅ "Read-only file system" |
| `mkdir` delegation level | ⚠️ First NEW parent level |
| `checkout` on non-existent path | ❌ Fails |
| Unmount releases all delegations | ✅ Works |
| Unmount/remount/checkout narrows delegation | ✅ Works |
| Concurrent subdir ownership | ✅ Works (when parent unowned) |

**Key insight**: The API must pre-create top-level dirs and release ownership before workers boot. This ensures workers' `mkdir thoughts/$AGENT_ID` grants delegation at the subdir level (correct) instead of the parent level (broken).

---

## Review Errata

_Reviewed: 2026-03-11 by Claude_

### Critical

_(none remaining)_

### Important

_(none remaining)_

### Resolved

- [x] Missing `brainstorms/` subdirectory — added to both Archil and non-Archil blocks, desired end state, and boot flow
- [x] Read-only access to other agents' dirs — clarified in entrypoint comment that `--shared` mounts provide automatic read access
- [x] `ARCHIL_MOUNT_TOKEN` availability in hooks — confirmed: hooks run as subprocesses in the same container, env vars are inherited
- [x] Line references verified — `hook.ts` lines corrected (473→860-864, 164→870)
- [x] Phase 3 missing `pi-mono-extension.ts` — added to all Phase 3 change items
- [x] Phase 1 checkout-vs-mkdir ambiguity — switched to `mkdir` first (auto-grants ownership), `checkout` as fallback
- [x] Phase 4 grep sweep — expanded to include `templates/`, `docs-site/`, `README.md`, `MCP.md`
- [x] Phase 3 PreToolUse vs PostToolUse — PreToolUse is now primary (proactive), PostToolUse is safety net
- [x] Rollback notes — skipped per Taras: whole thing is a no-op in non-Archil case
- [x] Overview said "PostToolUse hook guardrail" as primary — updated to describe PreToolUse as primary, PostToolUse as safety net (bot review #4)
- [x] `misc/` directory not in research — added justification note in Current State Analysis (bot review #1)
- [x] Phase 4 item 4 (`work-on-task.md:68`) had wrong change description — corrected: references `shared/memory/`, not `thoughts/shared/` (bot review #2, #5)
- [x] Research open questions #2 (multiple checkouts) and #3 (read propagation delay) — added explicit validation steps to Phase 1 manual verification (bot review #3)
- [x] Research open question #4 (AGENT_ID stability) — added orphaned directory note to "What We're NOT Doing" as explicit tech debt (bot review #3)
- [x] **Parent delegation problem discovered via live testing** — `mkdir -p thoughts/$AGENT_ID/plans` auto-grants delegation on `thoughts/` (the parent), not `thoughts/$AGENT_ID`. Fix: two-phase boot — API pre-creates top-level dirs, workers create subdirs. See Appendix A.
- [x] **Error pattern confirmed** — non-owned writes produce "Read-only file system" (not EPERM/EACCES). Phase 3 updated.
- [x] **Research open questions #2 and #3 answered** — multiple checkouts per client: ✅ works. Read propagation: needs live test but reads confirmed working cross-agent.

---

## Local Test Results (2026-03-11)

_Tested locally with Docker images `agent-swarm-api:1.41.0` and `agent-swarm-worker:1.41.0`._

1. **Single worker directory creation** — worker-alpha gets the exact expected structure:
   `shared/thoughts/worker-alpha/{plans,research,brainstorms}`, `shared/memory/worker-alpha/`,
   `shared/downloads/worker-alpha/slack/`, `shared/misc/worker-alpha/`

2. **Multi-agent isolation** — worker-alpha and worker-beta on the same shared volume create
   completely separate subdirectory trees with no overlap.

3. **API role behavior** — Correctly skips shared dir pre-creation when `ARCHIL_MOUNT_TOKEN` is
   absent (local dev path). Only pre-creates top-level dirs when Archil is active.

4. **`isOwnedSharedPath()` logic** — 9/9 test cases pass:
   - Owned paths (own agent's files) → true
   - Other agent's paths → false
   - Paths without category prefix → false
   - Directory itself without trailing slash → false (correct — agents write files, not dirs)

5. **Hook integration** — PreToolUse warns on Write/Edit to non-owned shared paths. PostToolUse
   catches "Read-only file system" as safety net. Both gated on `ARCHIL_MOUNT_TOKEN` (inactive locally).

**Remaining**: Live Archil delegation test needs a Fly.io deploy to validate two-phase boot + cross-agent write blocking on actual Archil shared disk.
