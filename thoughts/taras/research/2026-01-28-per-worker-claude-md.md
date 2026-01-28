---
date: 2026-01-28T14:52:00Z
topic: "Per-Worker CLAUDE.md Implementation"
researcher: Claude (Opus 4.5)
git_branch: main
status: complete
tags:
  - agents
  - configuration
  - CLAUDE.md
  - workers
  - database
  - UI
---

# Per-Worker CLAUDE.md Implementation Research

## Research Question

How to implement per-worker CLAUDE.md files that are:
1. Stored in the database per agent
2. Controllable from the UI
3. Contain default worker info (name, description, capabilities)
4. Modifiable by agents themselves
5. Loaded automatically when `claude` command starts (to `~/.claude/CLAUDE.md`)
6. Synced back to DB (via watch or on-end mechanism)
7. Include a unified note: "If you need to remember something write it down here"

---

## Summary

The agent-swarm codebase currently has no `claude_md` field in the agents table, but has all the infrastructure needed to implement this feature. The implementation requires:

1. **Database changes**: Add `claudeMd TEXT` column to `agents` table
2. **API changes**: Extend profile update endpoints to include `claudeMd`
3. **Hook changes**: On `SessionStart`, write agent's CLAUDE.md to `~/.claude/CLAUDE.md`
4. **MCP tool changes**: Add ability for agents to update their own CLAUDE.md
5. **UI changes**: Add CLAUDE.md editor in `EditAgentProfileModal`
6. **Sync mechanism**: On `Stop` hook, read `~/.claude/CLAUDE.md` and sync back to DB

---

## Detailed Findings

### 1. Current Agent Schema

**File:** `src/be/db.ts:48-59` (table creation) and `src/be/db.ts:467-495` (migrations)

Current `agents` table columns:
| Column | Type | Purpose |
|--------|------|---------|
| `id` | TEXT PRIMARY KEY | UUID |
| `name` | TEXT NOT NULL | Agent name |
| `isLead` | INTEGER DEFAULT 0 | Boolean flag |
| `status` | TEXT NOT NULL | 'idle', 'busy', 'offline' |
| `description` | TEXT | Free-form description |
| `role` | TEXT | Role label (max 100 chars) |
| `capabilities` | TEXT DEFAULT '[]' | JSON array |
| `maxTasks` | INTEGER DEFAULT 1 | Concurrency limit |
| `emptyPollCount` | INTEGER DEFAULT 0 | Polling tracking |
| `createdAt` | TEXT NOT NULL | ISO datetime |
| `lastUpdatedAt` | TEXT NOT NULL | ISO datetime |

**No `claudeMd` field exists yet.**

---

### 2. Agent Profile Update Mechanism

**MCP Tool:** `src/tools/update-profile.ts:1-132`
- Currently supports: `name`, `description`, `role`, `capabilities`
- Uses `updateAgentProfile()` from `src/be/db.ts:2117-2147`

**HTTP API:** `src/http.ts:968` - `PUT /api/agents/:id/profile`
- Same fields as MCP tool

**DB Function:** `src/be/db.ts:2117-2147`
```sql
UPDATE agents SET
  description = COALESCE(?, description),
  role = COALESCE(?, role),
  capabilities = COALESCE(?, capabilities),
  lastUpdatedAt = ?
WHERE id = ? RETURNING *
```

---

### 3. Hook System (Key Integration Point)

**File:** `src/hooks/hook.ts`

The hook receives events via stdin JSON and outputs to stdout. Key events:

| Event | Line | Current Behavior | Proposed Use |
|-------|------|------------------|--------------|
| `SessionStart` | 421-426 | Outputs agent status | **Load CLAUDE.md to ~/.claude/CLAUDE.md** |
| `Stop` | 484-501 | Marks agent offline | **Sync CLAUDE.md back to DB** |

**Current SessionStart handling (line 391-418):**
```typescript
if (agentInfo) {
  console.log(`You are registered as ${agentInfo.isLead ? "lead" : "worker"} agent...`);
  // ... system tray output
}
```

This is where we'd add CLAUDE.md file writing.

---

### 4. Worker Spawning Flow

**File:** `src/commands/runner.ts`

1. Worker starts via `runAgent()` at line 1268
2. Registers with API at lines 1369-1382
3. Enters polling loop at line 1476
4. On trigger, spawns Claude with `Bun.spawn()` at line 1009-1016
5. Claude invokes hooks via stdin/stdout

**System prompt injection:** Currently uses `--append-system-prompt` flag (line 987):
```typescript
if (opts.systemPrompt) {
  Cmd.push("--append-system-prompt", opts.systemPrompt);
}
```

However, Claude Code also reads `~/.claude/CLAUDE.md` automatically, which is what we want to leverage.

---

### 5. UI Components for Agent Management

**Edit Modal:** `ui/src/components/EditAgentProfileModal.tsx`
- Currently handles: role, description, capabilities
- Would need to add CLAUDE.md textarea

**API Client:** `ui/src/lib/api.ts:71-86`
```typescript
async updateAgentProfile(
  id: string,
  profile: { role?: string; description?: string; capabilities?: string[] },
): Promise<AgentWithTasks>
```

**React Query Hook:** `ui/src/hooks/queries.ts:34`
```typescript
export function useUpdateAgentProfile() {
  // mutation for profile updates
}
```

---

### 6. ~/.claude/CLAUDE.md Location

Claude Code reads from `~/.claude/CLAUDE.md` as global instructions. The hook has access to:
- `process.env.HOME` for user's home directory
- Full filesystem access via Bun APIs

---

## Code References

| Component | File | Line(s) |
|-----------|------|---------|
| Agents table schema | `src/be/db.ts` | 48-59 |
| Agent migrations | `src/be/db.ts` | 467-495 |
| updateAgentProfile DB | `src/be/db.ts` | 2117-2147 |
| update-profile MCP tool | `src/tools/update-profile.ts` | 1-132 |
| join-swarm MCP tool | `src/tools/join-swarm.ts` | 1-139 |
| HTTP profile endpoint | `src/http.ts` | 968 |
| Hook handler | `src/hooks/hook.ts` | 105-506 |
| SessionStart hook | `src/hooks/hook.ts` | 421-426 |
| Stop hook | `src/hooks/hook.ts` | 484-501 |
| Worker runner | `src/commands/runner.ts` | 1268-1629 |
| UI edit modal | `ui/src/components/EditAgentProfileModal.tsx` | 27 |
| UI API client | `ui/src/lib/api.ts` | 71-86 |
| Agent type definition | `src/types.ts` | 113-132 |

---

## Implementation Recommendations

### Phase 1: Database & API Layer

1. **Add migration in `src/be/db.ts`:**
```typescript
try {
  db.run(`ALTER TABLE agents ADD COLUMN claudeMd TEXT`);
} catch { /* exists */ }
```

2. **Update TypeScript types in `src/types.ts`:**
```typescript
export const AgentSchema = z.object({
  // ... existing fields
  claudeMd: z.string().optional(),
});
```

3. **Extend `updateAgentProfile()` in `src/be/db.ts`:**
```sql
UPDATE agents SET
  description = COALESCE(?, description),
  role = COALESCE(?, role),
  capabilities = COALESCE(?, capabilities),
  claudeMd = COALESCE(?, claudeMd),
  lastUpdatedAt = ?
WHERE id = ? RETURNING *
```

4. **Update `update-profile` tool in `src/tools/update-profile.ts`:**
- Add `claudeMd: z.string().optional()` to input schema

5. **Update HTTP endpoint in `src/http.ts`:**
- Add `claudeMd` to accepted body fields in `PUT /api/agents/:id/profile`

### Phase 2: CLAUDE.md Loading (Hook)

Modify `src/hooks/hook.ts` in the `SessionStart` handler:

```typescript
case "SessionStart":
  if (agentInfo) {
    // Existing status output...

    // Write agent's CLAUDE.md to ~/.claude/CLAUDE.md
    if (agentInfo.claudeMd) {
      const claudeMdPath = `${process.env.HOME}/.claude/CLAUDE.md`;
      await Bun.write(claudeMdPath, agentInfo.claudeMd);
      console.log(`Loaded your personal CLAUDE.md configuration.`);
    }
  }
  break;
```

Note: Need to fetch full agent info including `claudeMd` field in `getAgentInfo()`.

### Phase 3: CLAUDE.md Sync Back

On `Stop` hook, read the file and sync to DB:

```typescript
case "Stop":
  // Existing PM2 save...

  // Sync CLAUDE.md back to database
  const claudeMdPath = `${process.env.HOME}/.claude/CLAUDE.md`;
  try {
    const file = Bun.file(claudeMdPath);
    if (await file.exists()) {
      const content = await file.text();
      await syncClaudeMdToDb(agentInfo.id, content);
    }
  } catch { /* ignore */ }

  await close();
  break;
```

New helper function:
```typescript
async function syncClaudeMdToDb(agentId: string, content: string): Promise<void> {
  if (!mcpConfig) return;
  await fetch(`${getBaseUrl()}/api/agents/${agentId}/claude-md`, {
    method: "PUT",
    headers: { ...mcpConfig.headers, "Content-Type": "application/json" },
    body: JSON.stringify({ claudeMd: content }),
  });
}
```

### Phase 4: Default CLAUDE.md Template

When creating an agent, initialize with default template:

```markdown
# Agent: {{name}}

{{description}}

## Role
{{role}}

## Capabilities
{{capabilities as bullet list}}

---

## Notes

If you need to remember something, write it down here. This section is for
persistent notes that will be saved and loaded across sessions.

### Learnings

### Preferences

### Important Context
```

### Phase 5: UI Integration

1. **Add textarea to `EditAgentProfileModal.tsx`:**
```tsx
<Textarea
  label="CLAUDE.md"
  value={claudeMd}
  onChange={(e) => setClaudeMd(e.target.value)}
  rows={20}
  placeholder="Agent's personal CLAUDE.md configuration..."
/>
```

2. **Update API client in `ui/src/lib/api.ts`:**
```typescript
async updateAgentProfile(
  id: string,
  profile: { role?: string; description?: string; capabilities?: string[]; claudeMd?: string },
): Promise<AgentWithTasks>
```

3. **Add CLAUDE.md viewer in `AgentDetailPanel.tsx`:**
- Collapsible section showing current CLAUDE.md content
- Edit button that opens the modal

---

## Alternative Approaches Considered

### A. File-based sync with watch

Instead of syncing on `Stop`, use a file watcher:
- **Pros:** Real-time sync, survives crashes
- **Cons:** Complex, requires background process, potential race conditions

**Recommendation:** Start with `Stop` hook sync, add watcher later if needed.

### B. Per-session CLAUDE.md (temp file)

Write to a temp location, pass via `--system-prompt-file`:
- **Pros:** No conflicts with user's global CLAUDE.md
- **Cons:** Doesn't leverage Claude's native CLAUDE.md reading

**Recommendation:** Use `~/.claude/CLAUDE.md` directly for simplicity, but save/restore user's original if it exists.

### C. Merge with existing CLAUDE.md

Instead of overwriting, merge agent's config with existing user config:
- **Pros:** Preserves user customizations
- **Cons:** Complex merging, potential conflicts

**Recommendation:** For agent-swarm workers, overwrite is acceptable since workers run in isolated contexts (Docker, etc.).

---

## Decisions (from review)

1. **Conflict handling:** What if user has their own `~/.claude/CLAUDE.md`?
   - **Decision: Backup and restore** (Option A) ✓

2. **Size limits:** Should we limit CLAUDE.md size?
   - **Decision: 64KB max** (~5k LLM tokens) ✓

3. **Sync frequency:** Only on Stop, or periodic?
   - **Decision: Start with Stop only**, add periodic if users request ✓

4. **UI editing permissions:** Can any user edit any agent's CLAUDE.md?
   - **Decision: Yes, from the UI any user can edit** (existing auth model applies) ✓

---

## Next Steps

1. Create implementation plan based on phases above
2. Decide on conflict handling approach
3. Implement Phase 1 (DB/API) first
4. Test with manual CLAUDE.md injection
5. Implement Phase 2-3 (Hook integration)
6. Implement Phase 4-5 (UI)
