---
date: 2026-03-11T10:40:00Z
topic: "Archil Per-Agent Write Strategy Implementation"
author: Claude
status: draft
tags: [plan, archil, shared-disk, per-agent, ownership, fly-io]
research: "thoughts/taras/research/2026-03-11-archil-shared-disk-write-strategies.md"
autonomy: critical
---

# Archil Per-Agent Write Strategy Implementation Plan

## Overview

Implement per-agent write isolation on the shared Archil disk. Each agent gets exclusive write ownership of its own subdirectories (`thoughts/$AGENT_ID/`, `memory/$AGENT_ID/`, `downloads/$AGENT_ID/`, `misc/$AGENT_ID/`). All agents can read everything via the `--shared` mount. Write failures to non-owned directories are caught by a PostToolUse hook guardrail that hints the agent to use its own subdirectory.

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
- Archil `mkdir` on unowned dirs auto-grants ownership to the creator
- Archil `--shared` mounts are always fully readable by all clients

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

Boot flow per agent:
```
archil mount --shared {disk} /workspace/shared
→ archil checkout thoughts/$AGENT_ID      → mkdir -p plans/ research/ brainstorms/
→ archil checkout memory/$AGENT_ID        → (empty, agent writes as needed)
→ archil checkout downloads/$AGENT_ID     → mkdir -p slack/
→ archil checkout misc/$AGENT_ID          → (empty, catch-all)
```

Agent runtime:
- Write to own dirs: ✅ (owned via checkout)
- Read any agent's dirs: ✅ (shared mount)
- Write to another agent's dir: ❌ EPERM → hook hints "use your own dir"
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

## Implementation Approach

Four phases, each independently deployable and verifiable:

1. **Entrypoint**: Expand per-agent checkout to cover all write targets. Deploy and verify mounts. Also discover the exact FUSE error pattern for non-owned writes.
2. **Prompting**: Update base-prompt.ts to describe the new directory layout. Works with or without Archil.
3. **Hook guardrails**: Add PostToolUse error detection for non-owned write failures. Uses the error pattern discovered in Phase 1.
4. **Tool path updates**: Update hardcoded paths in slack download tool and pi-skills.

---

## Phase 1: Entrypoint — Per-Agent Directory Checkout

### Overview
Expand the `docker-entrypoint.sh` checkout block to cover `thoughts/$AGENT_ID`, `memory/$AGENT_ID`, `downloads/$AGENT_ID`, and `misc/$AGENT_ID`. Remove the broken `mkdir -p thoughts/shared/...` block. Deploy and test.

### Changes Required:

#### 1. Entrypoint checkout expansion
**File**: `docker-entrypoint.sh`
**Changes**:

Remove the broken shared mkdir block (currently around lines 55-58):
```bash
# REMOVE:
mkdir -p /workspace/shared/thoughts/shared/plans \
         /workspace/shared/thoughts/shared/research \
         /workspace/shared/memory 2>/dev/null || true
```

Replace the per-agent checkout block (currently around lines 477-486) with an expanded version.

**Primary approach: `mkdir -p` first** — Archil auto-grants ownership to the client that creates a directory on a `--shared` mount. This is simpler and avoids the question of whether `checkout` works on non-existent paths. Explicit `checkout` is used only as a fallback for dirs that already exist (e.g., on container restart where dirs persist from a previous boot).

```bash
if [ -n "$AGENT_ID" ]; then
    AGENT_SHARED="/workspace/shared"

    echo "Setting up per-agent directories for $AGENT_ID..."

    # IMPORTANT: The shared disk is already mounted via `archil mount --shared`
    # earlier in the entrypoint. That single mount gives this agent READ access
    # to the ENTIRE disk — including all other agents' directories.
    #
    # What we're doing here is claiming WRITE ownership of this agent's own
    # subdirectories only. Other agents' dirs (e.g., thoughts/worker-2/) are
    # visible and readable but not writable by this agent.
    #
    # On Archil --shared mounts, mkdir auto-grants ownership to the creator.
    # On non-Archil (local dev), this is just a regular mkdir.
    for category in "thoughts" "memory" "downloads" "misc"; do
        AGENT_DIR="$AGENT_SHARED/$category/$AGENT_ID"
        mkdir -p "$AGENT_DIR" 2>/dev/null || true

        # Fallback: if dir already existed (previous boot), claim via checkout
        if [ -n "$ARCHIL_MOUNT_TOKEN" ]; then
            sudo --preserve-env=ARCHIL_MOUNT_TOKEN archil checkout "$AGENT_DIR" 2>/dev/null || true
        fi
    done

    # Create standard subdirectories (within owned dirs, so these always succeed)
    mkdir -p "$AGENT_SHARED/thoughts/$AGENT_ID/plans"
    mkdir -p "$AGENT_SHARED/thoughts/$AGENT_ID/research"
    mkdir -p "$AGENT_SHARED/thoughts/$AGENT_ID/brainstorms"
    mkdir -p "$AGENT_SHARED/downloads/$AGENT_ID/slack"

    echo "Per-agent directories ready for $AGENT_ID"
fi
```

**Key clarification**: This block only sets up WRITE ownership for this agent's dirs. **Read access to ALL directories (including other agents') is already provided by the `archil mount --shared` call earlier in the entrypoint.** The lead can `cat /workspace/shared/thoughts/worker-1/plans/foo.md` without any checkout — reads are universal on `--shared` mounts.

### Success Criteria:

#### Automated Verification:
- [ ] Entrypoint runs without errors: `fly logs -a <app> --no-tail | grep -E "(Checking out|Per-agent directories ready|Error)"`
- [ ] All machines start successfully: `fly machines list -a <app>` shows all `started`
- [ ] Agent can write to own dir: SSH in and `echo test > /workspace/shared/thoughts/$AGENT_ID/test.txt`
- [ ] Agent can read other's dir: SSH in as agent-1 and `cat /workspace/shared/thoughts/agent-2/test.txt`

#### Manual Verification:
- [ ] Deploy to test swarm (e.g., zynap) and confirm all workers + lead boot cleanly
- [ ] **ERROR DISCOVERY**: SSH into a worker and attempt `echo test > /workspace/shared/thoughts/OTHER_AGENT_ID/test.txt` — record the exact error message (EPERM? EACCES? "Permission denied"? "Read-only file system"?). This error pattern will be used in Phase 3.
- [ ] Verify existing `thoughts/shared/` directory (if present) is still readable but not writable
- [ ] Verify `archil delegations /workspace/shared` shows each agent's checkouts

**Implementation Note**: After completing this phase, deploy and test on a live swarm. The error discovery here is critical input for Phase 3. Pause for confirmation before proceeding.

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
- [ ] TypeScript check passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint`
- [ ] No remaining references to `thoughts/shared/plans` or `thoughts/shared/research` as write targets: `grep -rn "thoughts/shared" src/prompts/`

#### Manual Verification:
- [ ] Read the generated prompt for a test agent and confirm the workspace layout section is clear and correct
- [ ] Verify agent ID substitution works correctly in the prompt

**Implementation Note**: This phase doesn't require a deploy to verify. TypeScript + lint is sufficient. Proceed to Phase 3 after confirmation.

---

## Phase 3: Hook Guardrails — Write Failure Detection

### Overview
Add PostToolUse error detection in `hook.ts` that catches write failures to non-owned directories on the shared disk and returns a helpful hint to the agent. Uses the exact error pattern discovered in Phase 1.

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
- [ ] TypeScript check passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint`
- [ ] Hook correctly identifies owned paths: test `isOwnedSharedPath("/workspace/shared/memory/agent-1/foo.md", "agent-1")` → true
- [ ] Hook correctly identifies non-owned paths: test `isOwnedSharedPath("/workspace/shared/memory/agent-2/foo.md", "agent-1")` → false
- [ ] Both `hook.ts` and `pi-mono-extension.ts` contain the guardrail logic

#### Manual Verification:
- [ ] Deploy and have an agent attempt to write to another agent's directory — verify the PreToolUse hint appears before the write
- [ ] Verify writes to own directory still work without any hook interference
- [ ] Verify the hint message is clear and actionable
- [ ] Test with pi-mono harness (if available) to confirm parity

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
**Changes** (around line 68): Update `thoughts/shared/` references to `thoughts/{agentId}/`.

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
- [ ] TypeScript check passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint`
- [ ] No remaining hardcoded shared write paths: `grep -rn "/workspace/shared/downloads/slack" src/ plugin/ templates/ docs-site/ README.md MCP.md` returns nothing
- [ ] No remaining `thoughts/shared` write targets: `grep -rn "thoughts/shared" src/ plugin/ templates/ docs-site/ README.md MCP.md | grep -v "read\|Read\|cat \|ls "` returns nothing

#### Manual Verification:
- [ ] Deploy and test Slack file download — verify file lands in `downloads/$AGENT_ID/slack/`
- [ ] Test a pi-mono agent's plan creation — verify plan goes to `thoughts/$AGENT_ID/plans/`

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
