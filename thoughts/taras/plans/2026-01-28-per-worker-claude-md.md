---
date: 2026-01-28T15:30:00Z
topic: "Per-Worker CLAUDE.md Implementation"
planner: Claude (Opus 4.5)
git_branch: main
status: draft
tags:
  - agents
  - configuration
  - CLAUDE.md
  - workers
  - database
  - UI
---

# Per-Worker CLAUDE.md Implementation Plan

## Overview

Implement per-worker CLAUDE.md files that are stored in the database per agent, controllable from the UI, contain default worker info, can be modified by agents themselves, loaded automatically when Claude Code starts, and synced back to the database on session end.

## Current State Analysis

**Database**: The `agents` table in `src/be/db.ts:48-58` has profile fields (`description`, `role`, `capabilities`) but no `claudeMd` field.

**Profile Updates**: The `updateAgentProfile()` function at `src/be/db.ts:2117-2147` handles `description`, `role`, and `capabilities` updates using SQL `COALESCE` pattern.

**Hook System**: The `SessionStart` handler at `src/hooks/hook.ts:421-426` currently only outputs agent status. The `Stop` handler at `src/hooks/hook.ts:484-501` marks agent offline and saves PM2 state.

**UI**: `EditAgentProfileModal.tsx` handles `role`, `description`, and `capabilities` editing.

**API**: HTTP endpoint `PUT /api/agents/:id/profile` at `src/http.ts:968` accepts profile updates.

### Key Discoveries:
- Agent info is fetched via `getAgentInfo()` at `src/hooks/hook.ts:169-188` which calls `GET /me?include=inbox`
- The hook has access to `mcpConfig.headers` and `mcpConfig.url` for API calls
- The `AgentRow` type at `src/be/db.ts:658-670` and `rowToAgent()` at `src/be/db.ts:672-686` handle data transformation
- MCP server URL base is extracted via `getBaseUrl()` at `src/hooks/hook.ts:128-135`

## Desired End State

1. **Database**: `claudeMd TEXT` column exists on `agents` table with 64KB limit
2. **API**: Profile update endpoints accept `claudeMd` field
3. **Hook - SessionStart**: Writes agent's `claudeMd` content to `~/.claude/CLAUDE.md` (with backup/restore of existing file)
4. **Hook - Stop**: Reads `~/.claude/CLAUDE.md` and syncs content back to database
5. **MCP Tool**: `update-profile` tool accepts `claudeMd` field
6. **UI**: `EditAgentProfileModal` includes a CLAUDE.md textarea editor
7. **Default Template**: New agents get a default CLAUDE.md with their info and a notes section

## Quick Verification Reference

Common commands to verify the implementation:
- `bun run lint:fix` - Lint and format
- `bun run tsc:check` - TypeScript type check
- `bun test` - Run tests

Key files to check:
- `src/be/db.ts` - Database schema and migrations
- `src/types.ts` - TypeScript type definitions
- `src/hooks/hook.ts` - Hook handlers
- `src/tools/update-profile.ts` - MCP tool
- `src/http.ts` - HTTP API endpoints
- `ui/src/components/EditAgentProfileModal.tsx` - UI modal
- `ui/src/lib/api.ts` - UI API client
- `ui/src/types/api.ts` - UI type definitions

## What We're NOT Doing

- File watcher for real-time sync (using Stop hook only for initial implementation)
- Merging agent CLAUDE.md with existing user CLAUDE.md (using backup/restore approach instead)
- Per-task CLAUDE.md (only per-agent)
- Version history or CLAUDE.md diffing
- Size validation beyond 64KB (trusting Claude's token limits)

## Implementation Approach

The implementation follows a layered approach, building from the database up to the UI:

1. **Phase 1**: Add `claudeMd` column to database and update types
2. **Phase 2**: Extend profile update functions (DB, API, MCP tool)
3. **Phase 3**: Implement SessionStart hook to load CLAUDE.md
4. **Phase 4**: Implement Stop hook to sync CLAUDE.md back
5. **Phase 5**: Add UI editor for CLAUDE.md

Each phase is independently testable and can be committed separately.

---

## Phase 1: Database Schema & Types

### Overview
Add the `claudeMd` column to the database schema and update all TypeScript type definitions.

### Changes Required:

#### 1. Database Migration
**File**: `src/be/db.ts`
**Changes**:
- Add migration to add `claudeMd TEXT` column to agents table (after line ~495)

```typescript
// CLAUDE.md storage column
try {
  db.run(`ALTER TABLE agents ADD COLUMN claudeMd TEXT`);
} catch {
  /* exists */
}
```

#### 2. AgentRow Type
**File**: `src/be/db.ts`
**Changes**:
- Add `claudeMd: string | null` to `AgentRow` type (line 658-670)

#### 3. rowToAgent Function
**File**: `src/be/db.ts`
**Changes**:
- Add `claudeMd: row.claudeMd ?? undefined` to `rowToAgent()` (line 672-686)

#### 4. Backend TypeScript Types
**File**: `src/types.ts`
**Changes**:
- Add `claudeMd: z.string().max(65536).optional()` to `AgentSchema` (line 113-132)

#### 5. Frontend TypeScript Types
**File**: `ui/src/types/api.ts`
**Changes**:
- Add `claudeMd?: string` to `Agent` interface (line 17-33)

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run tsc:check`
- [x] Linting passes: `bun run lint:fix`
- [x] Tests pass: `bun test`
- [ ] Server starts: `bun run start:http` (verify migration runs)

#### Manual Verification:
- [ ] Check SQLite database has `claudeMd` column: `sqlite3 agent-swarm-db.sqlite ".schema agents"`
- [ ] Verify existing agents still load correctly (no breaking change)

**Implementation Note**: After completing this phase, pause for manual confirmation before proceeding to Phase 2.

---

## Phase 2: Profile Update Functions

### Overview
Extend the profile update mechanism to accept and persist the `claudeMd` field through all layers: database function, HTTP API, and MCP tool.

### Changes Required:

#### 1. updateAgentProfile Database Function
**File**: `src/be/db.ts`
**Changes**:
- Add `claudeMd?: string` to the updates parameter type (line 2119-2123)
- Add `claudeMd` to the SQL UPDATE statement (line 2131-2136)
- Add `updates.claudeMd ?? null` to the prepared statement parameters (line 2138-2144)

The SQL becomes:
```sql
UPDATE agents SET
  description = COALESCE(?, description),
  role = COALESCE(?, role),
  capabilities = COALESCE(?, capabilities),
  claudeMd = COALESCE(?, claudeMd),
  lastUpdatedAt = ?
WHERE id = ? RETURNING *
```

#### 2. HTTP API Endpoint
**File**: `src/http.ts`
**Changes**:
- Add `claudeMd?: string` to the body type at line 985
- Add `claudeMd` check to the "at least one field" validation at line 995-999
- Add `claudeMd` size validation (max 64KB)
- Pass `claudeMd` to `updateAgentProfile()` call

#### 3. MCP update-profile Tool
**File**: `src/tools/update-profile.ts`
**Changes**:
- Add `claudeMd: z.string().max(65536).optional().describe("Personal CLAUDE.md content...")` to inputSchema (line 14-26)
- Add `claudeMd` to the "at least one field" validation (line 46-51)
- Pass `claudeMd` to `updateAgentProfile()` call (line 87-91)
- Add `claudeMd` to `updatedFields` tracking (line 104-108)

#### 4. UI API Client
**File**: `ui/src/lib/api.ts`
**Changes**:
- Add `claudeMd?: string` to the profile parameter type in `updateAgentProfile()` (line 71-73)

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run tsc:check`
- [x] Linting passes: `bun run lint:fix`
- [x] Tests pass: `bun test`

#### Manual Verification:
- [ ] Test HTTP API with curl:
  ```bash
  curl -X PUT http://localhost:3013/api/agents/<agent-id>/profile \
    -H "Content-Type: application/json" \
    -d '{"claudeMd": "# Test Agent\n\nTest content"}'
  ```
- [ ] Verify `claudeMd` is persisted in database
- [ ] Test MCP tool via Claude Code session

**Implementation Note**: After completing this phase, pause for manual confirmation before proceeding to Phase 3.

---

## Phase 3: SessionStart Hook - Load CLAUDE.md

### Overview
Modify the SessionStart hook handler to write the agent's `claudeMd` content to `~/.claude/CLAUDE.md`, backing up any existing file first.

### Changes Required:

#### 1. Add Helper Functions
**File**: `src/hooks/hook.ts`
**Changes**:
- Add constants for file paths near the top of the file:
```typescript
const CLAUDE_MD_PATH = `${process.env.HOME}/.claude/CLAUDE.md`;
const CLAUDE_MD_BACKUP_PATH = `${process.env.HOME}/.claude/CLAUDE.md.bak`;
```

- Add helper function to backup existing CLAUDE.md:
```typescript
async function backupExistingClaudeMd(): Promise<void> {
  const file = Bun.file(CLAUDE_MD_PATH);
  if (await file.exists()) {
    const content = await file.text();
    await Bun.write(CLAUDE_MD_BACKUP_PATH, content);
  }
}
```

- Add helper function to write agent's CLAUDE.md:
```typescript
async function writeAgentClaudeMd(content: string): Promise<void> {
  // Ensure ~/.claude directory exists
  const dir = `${process.env.HOME}/.claude`;
  try {
    await Bun.$`mkdir -p ${dir}`.quiet();
  } catch {
    // Directory may already exist
  }
  await Bun.write(CLAUDE_MD_PATH, content);
}
```

#### 2. Modify getAgentInfo to Include claudeMd
**File**: `src/hooks/hook.ts`
**Changes**:
- The `AgentWithInbox` interface already extends `Agent`, so it will include `claudeMd` automatically once the types are updated
- Verify `getAgentInfo()` (line 169-188) returns full agent data including `claudeMd`

#### 3. Modify SessionStart Handler
**File**: `src/hooks/hook.ts`
**Changes**:
- Update the `SessionStart` case (line 422-426) to:
```typescript
case "SessionStart":
  if (!agentInfo) break;

  // Write agent's CLAUDE.md if available
  if (agentInfo.claudeMd) {
    try {
      await backupExistingClaudeMd();
      await writeAgentClaudeMd(agentInfo.claudeMd);
      console.log("Loaded your personal CLAUDE.md configuration.");
    } catch (error) {
      console.log(`Warning: Could not load CLAUDE.md: ${(error as Error).message}`);
    }
  }
  break;
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run tsc:check`
- [x] Linting passes: `bun run lint:fix`
- [x] Tests pass: `bun test`

#### Manual Verification:
- [ ] Set an agent's `claudeMd` via API
- [ ] Start a Claude Code session with that agent
- [ ] Verify `~/.claude/CLAUDE.md` contains the agent's content
- [ ] Verify `~/.claude/CLAUDE.md.bak` contains the previous content (if any existed)
- [ ] Check the hook output shows "Loaded your personal CLAUDE.md configuration."

**Implementation Note**: After completing this phase, pause for manual confirmation before proceeding to Phase 4.

---

## Phase 4: Stop Hook - Sync CLAUDE.md Back

### Overview
Modify the Stop hook handler to read `~/.claude/CLAUDE.md`, sync it back to the database, and restore the backup file.

### Changes Required:

#### 1. Add Sync Function
**File**: `src/hooks/hook.ts`
**Changes**:
- Add helper function to sync CLAUDE.md back to server:
```typescript
async function syncClaudeMdToServer(agentId: string): Promise<void> {
  if (!mcpConfig) return;

  const file = Bun.file(CLAUDE_MD_PATH);
  if (!(await file.exists())) return;

  const content = await file.text();

  // Don't sync if content is empty or too large (>64KB)
  if (!content.trim() || content.length > 65536) return;

  try {
    await fetch(`${getBaseUrl()}/api/agents/${agentId}/profile`, {
      method: "PUT",
      headers: {
        ...mcpConfig.headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ claudeMd: content }),
    });
  } catch {
    // Silently fail - don't block shutdown
  }
}
```

- Add helper function to restore backup:
```typescript
async function restoreClaudeMdBackup(): Promise<void> {
  const backupFile = Bun.file(CLAUDE_MD_BACKUP_PATH);
  if (await backupFile.exists()) {
    const content = await backupFile.text();
    await Bun.write(CLAUDE_MD_PATH, content);
    // Remove backup file
    await Bun.$`rm -f ${CLAUDE_MD_BACKUP_PATH}`.quiet();
  } else {
    // No backup existed, remove the agent's CLAUDE.md
    await Bun.$`rm -f ${CLAUDE_MD_PATH}`.quiet();
  }
}
```

#### 2. Modify Stop Handler
**File**: `src/hooks/hook.ts`
**Changes**:
- Update the `Stop` case (line 484-501) to sync and restore before marking offline:
```typescript
case "Stop":
  // Save PM2 processes before shutdown (for container restart persistence)
  try {
    await Bun.$`pm2 save`.quiet();
  } catch {
    // PM2 not available or no processes - silently ignore
  }

  // Sync CLAUDE.md back to database and restore backup
  if (agentInfo?.id) {
    try {
      await syncClaudeMdToServer(agentInfo.id);
      await restoreClaudeMdBackup();
    } catch {
      // Silently fail - don't block shutdown
    }
  }

  // Mark the agent as offline
  await close();
  break;
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run tsc:check`
- [x] Linting passes: `bun run lint:fix`
- [x] Tests pass: `bun test`

#### Manual Verification:
- [ ] Start a Claude Code session with an agent that has `claudeMd` set
- [ ] Modify `~/.claude/CLAUDE.md` during the session (add some notes)
- [ ] Exit the Claude Code session (trigger Stop hook)
- [ ] Verify the agent's `claudeMd` in the database was updated with the new content
- [ ] Verify `~/.claude/CLAUDE.md` was restored to its original content (or removed if no backup)
- [ ] Verify `~/.claude/CLAUDE.md.bak` was removed

**Implementation Note**: After completing this phase, pause for manual confirmation before proceeding to Phase 5.

---

## Phase 5: UI Editor

### Overview
Add a CLAUDE.md textarea editor to the `EditAgentProfileModal` component.

### Changes Required:

#### 1. Add State and UI
**File**: `ui/src/components/EditAgentProfileModal.tsx`
**Changes**:
- Add state for `claudeMd`:
```typescript
const [claudeMd, setClaudeMd] = useState("");
```

- Initialize state from agent (in `useEffect` after line 67):
```typescript
setClaudeMd(agent.claudeMd || "");
```

- Add `claudeMd` to `handleSave` (line 74-81):
```typescript
await updateProfile.mutateAsync({
  id: agent.id,
  profile: {
    role: role || undefined,
    description: description || undefined,
    capabilities: capabilities.length > 0 ? capabilities : undefined,
    claudeMd: claudeMd || undefined,
  },
});
```

- Add `claudeMd` to `hasChanges` calculation (line 107-110):
```typescript
const hasChanges =
  role !== (agent.role || "") ||
  description !== (agent.description || "") ||
  claudeMd !== (agent.claudeMd || "") ||
  JSON.stringify(capabilities) !== JSON.stringify(agent.capabilities || []);
```

- Add CLAUDE.md textarea after the CAPABILITIES form control (around line 322):
```tsx
<FormControl>
  <FormLabel
    sx={{
      fontFamily: "code",
      color: colors.textSecondary,
      fontSize: "0.75rem",
      letterSpacing: "0.05em",
    }}
  >
    CLAUDE.MD
  </FormLabel>
  <Textarea
    value={claudeMd}
    onChange={(e) => setClaudeMd(e.target.value)}
    placeholder="Personal CLAUDE.md instructions and notes..."
    minRows={6}
    maxRows={12}
    sx={{
      fontFamily: "code",
      fontSize: "0.8rem",
      bgcolor: colors.level1,
      borderColor: colors.border,
      color: colors.textPrimary,
      "&:focus-within": {
        borderColor: colors.amber,
        boxShadow: colors.focusGlow,
      },
      "&:hover": {
        borderColor: colors.borderHover,
      },
    }}
  />
  <FormHelperText
    sx={{ fontFamily: "code", fontSize: "0.65rem", color: colors.textTertiary }}
  >
    Personal instructions loaded on session start. Notes you add here persist across sessions.
  </FormHelperText>
</FormControl>
```

#### 2. Update Modal Size
**File**: `ui/src/components/EditAgentProfileModal.tsx`
**Changes**:
- Increase modal width to accommodate the larger content (line 121):
```typescript
minWidth: 550,
maxWidth: 650,
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `cd ui && bun run typecheck`
- [x] Build succeeds: `cd ui && bun run build`

#### Manual Verification:
- [ ] Start the UI: `cd ui && bun run dev`
- [ ] Navigate to an agent's detail view
- [ ] Open the edit profile modal
- [ ] Verify CLAUDE.MD textarea is visible
- [ ] Enter some content in the CLAUDE.MD field
- [ ] Save the profile
- [ ] Verify the content persists (reopen modal)
- [ ] Start a Claude Code session with the agent
- [ ] Verify the CLAUDE.md content is loaded into `~/.claude/CLAUDE.md`

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Phase 6: Default Template (Optional Enhancement)

### Overview
Initialize new agents with a default CLAUDE.md template containing their info.

### Changes Required:

#### 1. Add Default Template Function
**File**: `src/be/db.ts`
**Changes**:
- Add function to generate default CLAUDE.md:
```typescript
export function generateDefaultClaudeMd(agent: { name: string; description?: string; role?: string; capabilities?: string[] }): string {
  const lines = [
    `# Agent: ${agent.name}`,
    "",
  ];

  if (agent.description) {
    lines.push(agent.description, "");
  }

  if (agent.role) {
    lines.push(`## Role`, agent.role, "");
  }

  if (agent.capabilities && agent.capabilities.length > 0) {
    lines.push(`## Capabilities`);
    agent.capabilities.forEach(cap => lines.push(`- ${cap}`));
    lines.push("");
  }

  lines.push(
    "---",
    "",
    "## Notes",
    "",
    "If you need to remember something, write it down here. This section persists across sessions.",
    "",
    "### Learnings",
    "",
    "### Preferences",
    "",
    "### Important Context",
    "",
  );

  return lines.join("\n");
}
```

#### 2. Use Default on Agent Creation
**File**: `src/tools/join-swarm.ts`
**Changes**:
- When creating a new agent, set initial `claudeMd` if not provided
- Call `updateAgentProfile()` with generated default after agent creation

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run tsc:check`
- [x] Tests pass: `bun test`

#### Manual Verification:
- [ ] Create a new agent via `join-swarm` MCP tool
- [ ] Check the agent's `claudeMd` field is populated with the default template
- [ ] Verify the template includes the agent's name, role, etc.

**Implementation Note**: This phase is optional and can be deferred. After completing, pause for manual confirmation.

---

## Testing Strategy

### Unit Tests
- Add tests for `generateDefaultClaudeMd()` function
- Add tests for `updateAgentProfile()` with `claudeMd` field

### Integration Tests
- Test HTTP API endpoint with `claudeMd` in request body
- Test MCP tool with `claudeMd` parameter

### Manual Testing
1. **Full flow test**:
   - Create agent or set `claudeMd` via UI
   - Start Claude Code session
   - Verify `~/.claude/CLAUDE.md` has agent's content
   - Add notes to the file during session
   - Exit session
   - Verify changes synced back to database
   - Verify original `~/.claude/CLAUDE.md` restored

2. **Edge cases**:
   - Agent with no `claudeMd` set (should not write file)
   - Existing `~/.claude/CLAUDE.md` file (backup/restore)
   - Large `claudeMd` content (~64KB)
   - Empty `claudeMd` content

## References
- Research document: `thoughts/taras/research/2026-01-28-per-worker-claude-md.md`
- Agent schema: `src/be/db.ts:48-58`
- Profile update function: `src/be/db.ts:2117-2147`
- Hook handler: `src/hooks/hook.ts:105-506`
- UI modal: `ui/src/components/EditAgentProfileModal.tsx`
