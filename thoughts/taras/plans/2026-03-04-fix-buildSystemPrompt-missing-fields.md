---
date: 2026-03-04T12:00:00Z
topic: "Fix buildSystemPrompt Missing Profile Fields"
status: completed
---

# Fix buildSystemPrompt Missing Profile Fields

## Problem

`buildSystemPrompt` in `src/commands/runner.ts` is missing several agent profile fields that are loaded from the DB but never injected into the system prompt:

1. **`toolsMd`** — Loaded from profile, defaults generated, written to `/workspace/TOOLS.md`, but never injected into the system prompt via `getBasePrompt`.
2. **`claudeMd`** (agent profile) — Default generated and pushed back to server, but never stored locally, never written to disk, never passed to the prompt. Completely dead.
3. **`name`** — Passed to `getBasePrompt` but never used in the function body.
4. **`description`** — Same as `name`.

## Plan

### Phase 1: Update `BasePromptArgs` and `getBasePrompt` in `src/prompts/base-prompt.ts`

1. Add `toolsMd?: string` to `BasePromptArgs`
2. Add `claudeMd?: string` to `BasePromptArgs` (agent-level, separate from `repoContext.claudeMd`)
3. In `getBasePrompt`, use `name` and `description` in the identity section (prepend to identity block or include in the role line).
4. In `getBasePrompt`, inject sections in this priority order:
   - Soul + Identity + Name/Description (core identity, always included)
   - Repo Context (protected, **never truncated**)
   - Agent CLAUDE.md (truncatable if prompt exceeds limit)
   - Tools (truncatable if prompt exceeds limit)
5. Add a system prompt length limit. When a truncatable section exceeds budget, truncate it and append: `[...truncated, see /workspace/<FILE>.md for full content]`.
6. Inject `toolsMd` under `## Your Tools & Capabilities` and `claudeMd` under `## Agent Instructions`.

**Verification:**
```bash
bun run tsc:check
```

### Phase 2: Update `buildSystemPrompt` in `src/commands/runner.ts`

1. Add local variable `agentClaudeMd` alongside `agentSoulMd`, `agentIdentityMd`, `agentToolsMd` (around line 1677).
2. Assign `agentClaudeMd = profile.claudeMd` when loading profile (around line 1824).
3. Generate default if missing: `if (!agentClaudeMd) agentClaudeMd = defaultClaudeMd || generateDefaultClaudeMd(agentInfo)` (around line 1843).
4. Pass `toolsMd: agentToolsMd` and `claudeMd: agentClaudeMd` to `getBasePrompt` in `buildSystemPrompt`.
5. Write `agentClaudeMd` to `/workspace/CLAUDE.md` alongside the other files (after line 1926).

**Verification:**
```bash
bun run tsc:check
bun run lint:fix
```

### Phase 3: Update log line

Update the log at line 1876 to include all fields:
```
Loaded agent identity (soul: yes, identity: yes, tools: yes, claude: yes)
```

**Verification:**
```bash
bun run tsc:check
bun test
```

### Manual E2E

1. Start API server: `bun run start:http`
2. Create/update an agent profile with all fields populated via API
3. Start a worker and verify logs show all fields loaded
4. Check that `/workspace/CLAUDE.md`, `/workspace/TOOLS.md`, `/workspace/SOUL.md`, `/workspace/IDENTITY.md` are all written
5. Verify the system prompt passed to Claude includes toolsMd and claudeMd content

## Decisions (from review)

1. **Inject into prompt + write to disk** — Yes, both. Add a total system prompt length limit with truncation. When truncating, show an indicator like `[...truncated, see /workspace/TOOLS.md]` so the agent knows where to find the full content.
2. **Both claudeMd sources coexist** — Agent profile `claudeMd` = general agent instructions. Repo `repoContext.claudeMd` = repo-specific rules. Both are included. Repo context is **never truncated**.
3. **Section order with priority**: Soul → Identity → Name/Description → Repo Context (protected, never cut) → Agent CLAUDE.md (truncatable) → Tools (truncatable). Lower-priority sections are truncated first when hitting the limit.
