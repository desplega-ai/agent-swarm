# Context Versioning for Agent Identity Files

**Author:** Researcher (16990304-76e4-4017-b991-f3e37b34cf73)
**Date:** 2026-02-24
**Status:** Proposal
**Related:** PR #76 (agent self-improvement), CDLC analysis, P8 (deferred in PR #76 as "too much for now")

---

## Problem Statement

When agents edit SOUL.md, IDENTITY.md, TOOLS.md, CLAUDE.md, or setup scripts, every change is a destructive overwrite. The `updateAgentProfile()` function in `db.ts:2613-2672` uses `COALESCE(?, column)` — when a new value is provided, the old value is gone. There is:

- **No history** — Can't see what an agent's identity looked like last week
- **No diffs** — Can't compare before/after when the lead coaches a worker
- **No rollback** — A bad identity edit (by agent or lead) can't be reverted
- **No attribution** — Can't tell if a change was self-edit, lead coaching, or automated
- **No correlation** — Can't tie a context change to improved/degraded task performance

The CDLC framework (analyzed in our research) calls this "context as packages with versioning and distribution." PR #76 identified this as P8 and deferred it. This plan makes it concrete.

---

## What to Version

### Versioned Fields (5 total)

| Field | DB Column | Workspace File | In System Prompt? | Max Size |
|-------|-----------|----------------|-------------------|----------|
| Soul | `soulMd` | `/workspace/SOUL.md` | Yes | 64KB |
| Identity | `identityMd` | `/workspace/IDENTITY.md` | Yes | 64KB |
| Tools | `toolsMd` | `/workspace/TOOLS.md` | No (file only) | 64KB |
| Claude Config | `claudeMd` | `~/.claude/CLAUDE.md` | No (Claude reads it) | 64KB |
| Setup Script | `setupScript` | `/workspace/start-up.sh` | No (executed) | 64KB |

All five are TEXT columns on the `agents` table, synced bidirectionally between DB and filesystem via hooks (`hook.ts:307-421`) and the `update-profile` tool.

### What NOT to version (yet)

- **Base prompt template** (`base-prompt.ts`) — This is code, versioned by git. Changes are PRs, not runtime edits.
- **Memory entries** — Already immutable (create-only, no updates). Versioning is N/A.
- **Task data** — Already has `agent_log` for status transitions. Not in scope.

---

## Recommended Approach: DB-Based History Table

### Why not git-based?

Git-based versioning (context files committed to a repo) sounds elegant but has practical problems in our architecture:

1. **Identity lives in the DB, not the filesystem.** The DB is the source of truth. Files are ephemeral workspace copies regenerated at session start (`runner.ts:1863-1905`). A git-based approach would need a separate "context repo" that mirrors DB state — adding a sync layer on top of the existing sync layer.
2. **Edits happen through multiple paths.** The `update-profile` MCP tool, the REST API (`PUT /api/agents/:id/profile`), PostToolUse hooks, and Stop hooks all write to the same DB columns. A git-based system would need to intercept all four paths.
3. **Per-agent branching adds complexity.** Each agent would need its own branch or directory, and merging/rebasing context makes no sense.
4. **Authentication and access.** Git operations need credentials. The swarm server already has DB access.

### Why DB-based?

1. **Single source of truth.** The DB already stores these fields. Adding a history table keeps everything co-located.
2. **All write paths converge to one function.** `updateAgentProfile()` in `db.ts:2613` is the single bottleneck. We intercept one function.
3. **Query-friendly.** SQL makes it trivial to query "show me all changes to Researcher's SOUL.md in the last week" or "what changed right before task performance dropped."
4. **No external dependencies.** No git credentials, no extra repos, no sync daemons.
5. **Lightweight.** A simple INSERT before the UPDATE. Minimal performance impact.

---

## Schema Design

### New Table: `context_versions`

```sql
CREATE TABLE IF NOT EXISTS context_versions (
  id TEXT PRIMARY KEY,                    -- UUID
  agentId TEXT NOT NULL,                  -- Which agent's context
  field TEXT NOT NULL,                    -- 'soulMd' | 'identityMd' | 'toolsMd' | 'claudeMd' | 'setupScript'
  content TEXT NOT NULL,                  -- The full content at this version
  version INTEGER NOT NULL,              -- Monotonically increasing per (agentId, field)
  changeSource TEXT NOT NULL,            -- 'self_edit' | 'lead_coaching' | 'api' | 'system' | 'session_sync'
  changedByAgentId TEXT,                 -- Who made the change (null for system/api)
  changeReason TEXT,                     -- Optional: why the change was made
  contentHash TEXT NOT NULL,             -- SHA-256 hash for dedup (skip saving if content unchanged)
  previousVersionId TEXT,                -- FK to previous version for linked list traversal
  createdAt TEXT NOT NULL,
  FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE,
  FOREIGN KEY (changedByAgentId) REFERENCES agents(id) ON DELETE SET NULL,
  FOREIGN KEY (previousVersionId) REFERENCES context_versions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_cv_agent_field ON context_versions(agentId, field, version DESC);
CREATE INDEX IF NOT EXISTS idx_cv_agent_created ON context_versions(agentId, createdAt DESC);
CREATE INDEX IF NOT EXISTS idx_cv_hash ON context_versions(agentId, field, contentHash);
```

### Key Design Decisions

1. **Per-field versioning.** Each field (soulMd, identityMd, etc.) is versioned independently. A SOUL.md edit doesn't increment the IDENTITY.md version. This makes diffs and rollbacks granular.

2. **Content hash dedup.** Before creating a version, compute `SHA-256(content)`. If the hash matches the current version's hash for that (agentId, field), skip the insert. This prevents noise from hooks that sync unchanged files (e.g., Stop hook always syncs all identity files, even if unchanged).

3. **Change source attribution.** The `changeSource` field distinguishes:
   - `self_edit` — Agent edited its own file (PostToolUse hook on Write/Edit to SOUL.md etc.)
   - `lead_coaching` — Lead used `update-profile` or `inject-learning` targeting another agent
   - `api` — REST API call (external tooling, UI)
   - `system` — Default template generation at first registration
   - `session_sync` — Stop hook final sync (should be rare if dedup works)

4. **Linked list for fast traversal.** `previousVersionId` allows walking the version chain without querying by version number. Useful for UI rendering.

5. **No content diffing in DB.** Diffs are computed at query time, not stored. Storing diffs would save space but make rollbacks harder (need to reconstruct full content from chain of patches).

---

## Implementation: Change Points

### 1. `updateAgentProfile()` in `db.ts:2613`

**Current behavior:** Directly overwrites columns with `COALESCE`.

**New behavior:** Before the UPDATE, for each field that has a new value:
1. Read current value from the row
2. Compute SHA-256 of new value
3. If hash differs from current version's hash → INSERT into `context_versions`
4. Then proceed with the existing UPDATE

```typescript
// Pseudocode for the change
function updateAgentProfile(id: string, updates: ProfileUpdates, meta?: VersionMeta): AgentRow {
  const db = getDb();

  return db.transaction(() => {
    // 1. Get current agent state
    const current = db.prepare("SELECT * FROM agents WHERE id = ?").get(id);

    // 2. For each changed field, create a version entry
    const versionableFields = ['soulMd', 'identityMd', 'toolsMd', 'claudeMd', 'setupScript'];
    for (const field of versionableFields) {
      const newValue = updates[field];
      if (newValue === undefined || newValue === null) continue;

      const currentValue = current[field] ?? '';
      const newHash = sha256(newValue);
      const currentHash = sha256(currentValue);

      if (newHash === currentHash) continue; // No actual change

      const latestVersion = getLatestVersion(id, field);
      const version = (latestVersion?.version ?? 0) + 1;

      createVersion({
        agentId: id,
        field,
        content: newValue,
        version,
        changeSource: meta?.changeSource ?? 'api',
        changedByAgentId: meta?.changedByAgentId ?? null,
        changeReason: meta?.changeReason ?? null,
        contentHash: newHash,
        previousVersionId: latestVersion?.id ?? null,
      });
    }

    // 3. Proceed with existing UPDATE logic (unchanged)
    return db.prepare(`UPDATE agents SET ... WHERE id = ? RETURNING *`).get(...);
  })();
}
```

### 2. Hook sync functions in `hook.ts`

**`syncIdentityFilesToServer()` (line 335):**
Currently sends `PUT /api/agents/{id}/profile` with file contents. The REST endpoint calls `updateAgentProfile()`, which will now auto-version.

**Change needed:** Pass `changeSource` metadata through the REST API.

Add an optional `X-Change-Source` header (or body field) to the `PUT /api/agents/:id/profile` endpoint:
- PostToolUse hook sets `changeSource: 'self_edit'`
- Stop hook sets `changeSource: 'session_sync'`
- `update-profile` MCP tool determines source based on whether the caller is the agent itself or the lead

### 3. `update-profile` MCP tool (`update-profile.ts`)

**Change needed:** Detect if the caller is updating their own profile or another agent's profile:
- Same agent → `changeSource: 'self_edit'`
- Lead updating worker → `changeSource: 'lead_coaching'`

The tool already has `requestInfo.agentId` (line 66) and validates ownership. Add metadata forwarding to `updateAgentProfile()`.

### 4. REST API endpoint (`http.ts:1153`)

**Change needed:** Accept optional `changeSource`, `changedByAgentId`, and `changeReason` fields in the request body or headers. Pass them through to `updateAgentProfile()`.

### 5. Default template generation (`db.ts:2424-2610`)

When defaults are generated at first registration, create version 1 with `changeSource: 'system'`.

---

## New MCP Tools

### `context-history`

View version history for an agent's context files.

```typescript
// Input
{
  agentId?: string,     // Default: caller's ID. Lead can query any agent.
  field?: string,       // Filter by field. Omit for all fields.
  limit?: number,       // Default: 10
}

// Output
{
  versions: [
    {
      id: string,
      field: string,
      version: number,
      changeSource: string,
      changedByAgentId: string | null,
      changeReason: string | null,
      contentLength: number,     // Don't return full content in list view
      createdAt: string,
    }
  ]
}
```

### `context-diff`

Compare two versions of a context file.

```typescript
// Input
{
  versionId: string,             // The "newer" version
  compareToVersionId?: string,   // The "older" version. Default: previous version.
}

// Output
{
  field: string,
  fromVersion: number,
  toVersion: number,
  diff: string,          // Unified diff format
  changeSource: string,
  createdAt: string,
}
```

Implementation: Use a simple line-based diff algorithm. No need for external dependencies — a basic LCS diff or even `Bun.spawn(['diff', ...])` on temp files would work.

### `context-rollback`

Revert a context field to a previous version.

```typescript
// Input
{
  versionId: string,     // The version to restore
  reason?: string,       // Why rolling back
}

// Output
{
  field: string,
  restoredToVersion: number,
  newVersion: number,          // The rollback creates a NEW version
  agentId: string,
}
```

Important: Rollback does NOT delete history. It creates a new version whose content matches the target version, with `changeSource: 'rollback'` and `changeReason` noting which version was restored. This preserves the full audit trail.

---

## Diff and History

### How diffs work

Diffs are computed at query time by comparing the `content` field of two `context_versions` rows. The `context-diff` tool fetches both versions, writes them to temp files, and runs `diff -u` to produce a unified diff.

For the UI (if we build one), the API would expose a `GET /api/agents/:id/context-history` endpoint returning the version list, and `GET /api/context-versions/:id/diff` returning the diff.

### Attribution

Each version records `changeSource` and `changedByAgentId`. The history view shows:

```
v5  2026-02-24 06:30  self_edit       (Researcher edited SOUL.md)
v4  2026-02-23 14:00  lead_coaching   by Lead (updated working style)
v3  2026-02-20 10:00  self_edit       (Researcher refined expertise section)
v2  2026-02-18 09:00  api             (external tool updated via REST)
v1  2026-02-15 12:00  system          (default template generated)
```

---

## Rollback

Rollback is implemented as a forward operation: create a new version with the content of a previous version.

```
v6  2026-02-24 07:00  rollback        "Reverted to v3 — v4/v5 degraded task quality"
v5  2026-02-24 06:30  self_edit
v4  2026-02-23 14:00  lead_coaching
v3  2026-02-20 10:00  self_edit       ← content restored from here
```

The `context-rollback` tool:
1. Reads the target version's content
2. Calls `updateAgentProfile()` with that content and `changeSource: 'rollback'`
3. The versioning system creates v6 automatically
4. The workspace files are updated (existing behavior of `updateAgentProfile`)

Access control: An agent can rollback its own context. The lead can rollback any agent's context.

---

## Correlation with Task Performance

### The Link: `context_version_id` on tasks

Add a column to `agent_tasks`:

```sql
ALTER TABLE agent_tasks ADD COLUMN contextSnapshotId TEXT;
```

When a task starts (`task_status_change` to `in_progress`), record the current version IDs for the agent's soulMd and identityMd (the two fields injected into the system prompt). This creates a queryable link:

```sql
-- "Did task quality change after the SOUL.md edit on Feb 23?"
SELECT
  t.id, t.status, t.output,
  cv.version as soul_version, cv.createdAt as soul_changed_at
FROM agent_tasks t
JOIN context_versions cv ON cv.id = t.contextSnapshotId
WHERE t.agentId = ? AND cv.field = 'soulMd'
ORDER BY t.createdAt;
```

### Simpler alternative (Phase 1): timestamp-based correlation

Skip the FK and just use timestamps. Since `context_versions.createdAt` and `agent_tasks.createdAt` are both ISO timestamps, you can correlate by time window:

```sql
-- Find context changes near a performance shift
SELECT * FROM context_versions
WHERE agentId = ? AND createdAt BETWEEN ? AND ?
ORDER BY createdAt;
```

This is less precise but requires zero schema changes to `agent_tasks` and works for Phase 1.

---

## Distribution: Lead-to-Worker Context Propagation

When the lead updates a worker's context via `update-profile` or through a future "context template" system, the versioning captures it automatically:

1. Lead calls `update-profile` targeting worker → `changeSource: 'lead_coaching'`, `changedByAgentId: <lead-id>`
2. Version is created in `context_versions`
3. Next time the worker's runner starts a session, it fetches the updated profile from DB → writes to workspace files → worker sees the new context

### Future: Context Templates

A natural extension (not in scope for v1) is "context templates" — the lead defines a base SOUL.md/IDENTITY.md template that's distributed to multiple workers. Template changes propagate to all workers, but workers can override specific sections. This builds on the versioning foundation.

---

## Migration Path

### Changes to existing files

| File | Change | Effort |
|------|--------|--------|
| `src/be/db.ts` | Add `context_versions` table, `createVersion()`, `getVersionHistory()`, `getVersion()`, `getLatestVersion()` functions. Modify `updateAgentProfile()` to create versions. | Medium |
| `src/http.ts` | Add `changeSource`/`changedByAgentId` params to `PUT /api/agents/:id/profile`. Add `GET /api/agents/:id/context-history` and `GET /api/context-versions/:id/diff` endpoints. | Medium |
| `src/hooks/hook.ts` | Pass `changeSource` metadata in sync functions (`syncIdentityFilesToServer`, `syncClaudeMdToServer`, `syncSetupScriptToServer`). | Small |
| `src/tools/update-profile.ts` | Detect self-edit vs lead-coaching based on caller. Pass metadata to `updateAgentProfile()`. | Small |

### New files

| File | Purpose | Effort |
|------|---------|--------|
| `src/tools/context-history.ts` | MCP tool: view version history | Small |
| `src/tools/context-diff.ts` | MCP tool: compare versions | Small |
| `src/tools/context-rollback.ts` | MCP tool: revert to a previous version | Small |

### No changes needed

- `runner.ts` — Session start reads from `agents` table (unchanged). Version history is append-only and doesn't affect the read path.
- `base-prompt.ts` — System prompt assembly is unchanged. It reads from the `agents` table.
- `embedding.ts`, `chunking.ts` — Memory system is independent.
- `inject-learning.ts` — This creates memories, not context edits. Unchanged.

---

## Phased Approach

### Phase 1: Version History (Minimal Useful)

**Goal:** Every context change is recorded. You can view history and diffs.

**Scope:**
- [ ] Create `context_versions` table in `db.ts`
- [ ] Add `createVersion()`, `getLatestVersion()`, `getVersionHistory()`, `getVersion()` DB functions
- [ ] Modify `updateAgentProfile()` to create versions (with content hash dedup)
- [ ] Add `changeSource` parameter threading through REST API and hooks
- [ ] Implement `context-history` MCP tool
- [ ] Implement `context-diff` MCP tool
- [ ] Seed v1 for existing agents (backfill current content as version 1)

**Estimated effort:** ~300 lines of new code, ~50 lines of modifications.

**Value:** Agents and the lead can now see "what changed and when" for any identity file. The lead can review what workers changed about themselves. History is preserved.

### Phase 2: Rollback and Attribution

**Goal:** Bad changes can be reverted. Change sources are fully tracked.

**Scope:**
- [ ] Implement `context-rollback` MCP tool
- [ ] Distinguish self-edit vs lead-coaching vs api vs system in all write paths
- [ ] Add `changeReason` support (optional annotation on why a change was made)
- [ ] Add REST API endpoints for history and diff (for UI consumption)
- [ ] Add retention policy (keep last N versions per field, or versions from last M days)

**Estimated effort:** ~200 lines new, ~30 lines modifications.

**Value:** Recovery from bad edits. Clear attribution. Prevents unbounded storage growth.

### Phase 3: Performance Correlation

**Goal:** Tie context changes to task outcomes.

**Scope:**
- [ ] Add `contextSnapshotId` to `agent_tasks` (or use timestamp-based correlation)
- [ ] Build query helpers: "show me task outcomes before/after this context change"
- [ ] Integrate with future eval system (from CDLC Evaluate stage)

**Estimated effort:** ~100 lines new.

**Value:** Data-driven context optimization. Can answer "did this SOUL.md change make the agent better or worse?"

### Phase 4: Distribution and Templates (Future)

**Goal:** Context as distributable packages.

**Scope:**
- [ ] Context templates (lead defines base, workers inherit + override)
- [ ] Template propagation (change template → update all workers)
- [ ] Context diffing across agents (compare two workers' identities)
- [ ] Export/import (move a well-tuned context to a new agent)

**Value:** Scalable context management across growing swarm. Aligns with CDLC "Distribute" stage.

---

## Storage Considerations

### Space usage

Each version stores the full content (not a diff). For 5 fields at ~5KB average, that's ~25KB per "full snapshot." With hash dedup preventing no-op versions, and most edits affecting 1-2 fields at a time, realistic growth is ~5-10KB per actual edit.

At 10 edits/day across the swarm (generous estimate), that's ~50-100KB/day = ~36MB/year. SQLite handles this trivially.

### Retention

Phase 2 adds a retention policy. Options:
- **Keep all** (simplest, recommended for v1) — storage is negligible
- **Keep last N per field** (e.g., 100 versions) — bounded, still has good history
- **Time-based** (e.g., keep 90 days) — aligns with session cost retention

### Backfill

On first deployment, create version 1 for all existing agents' current context:

```sql
-- Run once at migration time
INSERT INTO context_versions (id, agentId, field, content, version, changeSource, contentHash, createdAt)
SELECT
  lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))),
  id, 'soulMd', soulMd, 1, 'system', hex(sha256(soulMd)), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM agents WHERE soulMd IS NOT NULL;
-- Repeat for identityMd, toolsMd, claudeMd, setupScript
```

(In practice, this would be done in TypeScript using the existing `crypto` module for proper UUID generation and SHA-256.)

---

## Open Questions

1. **Should `toolsMd` be in the system prompt?** Currently it's file-only. If it becomes more important (e.g., for tool selection), we might want it in the prompt — and then it becomes higher priority for versioning.

2. **Should agents be able to see each other's context history?** Current proposal: agents see their own, lead sees all. Workers seeing other workers' context could enable peer learning but also adds noise.

3. **Event-driven notifications?** When the lead edits a worker's context, should the worker be notified (e.g., via channel message)? This would make the feedback loop explicit.

4. **Integration with the eval system?** Phase 3 connects to the CDLC "Evaluate" stage. The eval system design (separate research) would define what "task quality" means. Context versioning provides the independent variable; evals provide the dependent variable.
