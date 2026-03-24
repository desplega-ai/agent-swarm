---
date: 2026-03-24T00:00:00Z
author: Jackknife
topic: "Skill System Implementation Plan"
tags: [skill-system, implementation-plan, agent-swarm]
status: complete
repository: desplega-ai/agent-swarm
---

# Skill System Implementation Plan

**Date:** 2026-03-24
**Status:** Plan (not yet implemented)
**Based on:** Skill System v3 Research (DB-Based Design), approved by Taras
**Tag:** `autopilot-plan`

---

## Overview

Add a skill system to the agent swarm that lets agents discover, create, install, and use skills. Skills are SKILL.md-based instruction sets stored in the database (simple skills) or installed from GitHub repos via `npx skills` (complex skills). Both types are synced to the filesystem so Claude Code and Cursor/Pi harnesses discover them natively.

### Confirmed Design Decisions (from Taras)

1. **Personal skills take precedence** over remote skills with the same name
2. **Publishing personal skills to swarm scope** creates a task for lead approval (not auto-publish)
3. **Remote skill refresh:** daily or on-demand — no complex cron needed
4. **UI supports both** simple SKILL.md skills AND complex multi-file skills (npx)
5. **Cursor/Pi paths:** `~/.cursor/skills/<name>/SKILL.md` (also reads `~/.claude/skills/`)

---

## Phase 1: DB Schema + Migration

### Migration `019_skills.sql`

**File:** `src/be/migrations/019_skills.sql`

```sql
-- Skills table: stores skill definitions
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',

  -- Type & ownership
  type TEXT NOT NULL DEFAULT 'personal'
    CHECK (type IN ('remote', 'personal')),
  scope TEXT NOT NULL DEFAULT 'agent'
    CHECK (scope IN ('global', 'swarm', 'agent')),
  ownerAgentId TEXT,

  -- Remote skill metadata
  sourceUrl TEXT,
  sourceRepo TEXT,
  sourcePath TEXT,
  sourceBranch TEXT DEFAULT 'main',
  sourceHash TEXT,
  isComplex INTEGER DEFAULT 0,

  -- Parsed frontmatter cache (denormalized)
  allowedTools TEXT,
  model TEXT,
  effort TEXT,
  context TEXT,
  agent TEXT,
  disableModelInvocation INTEGER DEFAULT 0,
  userInvocable INTEGER DEFAULT 1,

  -- Metadata
  version INTEGER NOT NULL DEFAULT 1,
  isEnabled INTEGER NOT NULL DEFAULT 1,

  createdAt TEXT NOT NULL,
  lastUpdatedAt TEXT NOT NULL,
  lastFetchedAt TEXT,

  FOREIGN KEY (ownerAgentId) REFERENCES agents(id)
);

-- Unique constraint: name must be unique within scope+owner combination
CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_name_scope
  ON skills(name, scope, COALESCE(ownerAgentId, ''));

CREATE INDEX IF NOT EXISTS idx_skills_type ON skills(type);
CREATE INDEX IF NOT EXISTS idx_skills_scope ON skills(scope);
CREATE INDEX IF NOT EXISTS idx_skills_owner ON skills(ownerAgentId);

-- Agent-skill junction table
CREATE TABLE IF NOT EXISTS agent_skills (
  id TEXT PRIMARY KEY,
  agentId TEXT NOT NULL,
  skillId TEXT NOT NULL,
  isActive INTEGER NOT NULL DEFAULT 1,
  installedAt TEXT NOT NULL,

  FOREIGN KEY (agentId) REFERENCES agents(id),
  FOREIGN KEY (skillId) REFERENCES skills(id) ON DELETE CASCADE,
  UNIQUE(agentId, skillId)
);

CREATE INDEX IF NOT EXISTS idx_agent_skills_agent ON agent_skills(agentId);
CREATE INDEX IF NOT EXISTS idx_agent_skills_skill ON agent_skills(skillId);
```

### DB Functions (`src/be/db.ts` additions)

Add the following query functions:

| Function | Signature | Description |
|----------|-----------|-------------|
| `createSkill` | `(skill: SkillInsert) => Skill` | Insert a new skill, parse frontmatter to denormalized fields |
| `updateSkill` | `(id: string, updates: Partial<SkillInsert>) => Skill` | Update skill, re-parse frontmatter if content changed, bump version |
| `deleteSkill` | `(id: string) => void` | Delete skill (cascades to agent_skills) |
| `getSkill` | `(id: string) => Skill \| null` | Get skill by ID |
| `getSkillByName` | `(name: string, scope: string, ownerAgentId?: string) => Skill \| null` | Get skill by name within scope |
| `listSkills` | `(filters: SkillFilters) => Skill[]` | List skills with optional filters (type, scope, owner, enabled) |
| `searchSkills` | `(query: string) => Skill[]` | FTS or LIKE search on name + description |
| `installSkill` | `(agentId: string, skillId: string) => AgentSkill` | Add to agent_skills junction |
| `uninstallSkill` | `(agentId: string, skillId: string) => void` | Remove from agent_skills |
| `getAgentSkills` | `(agentId: string, activeOnly?: boolean) => SkillWithInstallInfo[]` | Get all skills for an agent (joins skills + agent_skills), **ordered by precedence** (personal first) with deduplication by name |
| `toggleAgentSkill` | `(agentId: string, skillId: string, isActive: boolean) => void` | Toggle skill active/inactive for agent |

### Types (`src/types.ts` additions)

```typescript
export interface Skill {
  id: string;
  name: string;
  description: string;
  content: string;
  type: "remote" | "personal";
  scope: "global" | "swarm" | "agent";
  ownerAgentId: string | null;
  sourceUrl: string | null;
  sourceRepo: string | null;
  sourcePath: string | null;
  sourceBranch: string;
  sourceHash: string | null;
  isComplex: boolean;
  allowedTools: string | null;
  model: string | null;
  effort: string | null;
  context: string | null;
  agent: string | null;
  disableModelInvocation: boolean;
  userInvocable: boolean;
  version: number;
  isEnabled: boolean;
  createdAt: string;
  lastUpdatedAt: string;
  lastFetchedAt: string | null;
}

export interface AgentSkill {
  id: string;
  agentId: string;
  skillId: string;
  isActive: boolean;
  installedAt: string;
}
```

### Frontmatter Parser

**File:** `src/be/skill-parser.ts`

A utility that parses SKILL.md content (YAML frontmatter + markdown body):

```typescript
export function parseSkillContent(content: string): {
  name: string;
  description: string;
  allowedTools?: string;
  model?: string;
  effort?: string;
  context?: string;
  agent?: string;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  body: string;
}
```

- Uses a simple YAML frontmatter parser (split on `---` delimiters, parse key-value pairs)
- Validates required fields: `name`, `description`
- Returns parsed metadata + raw markdown body
- Called by `createSkill` and `updateSkill` to populate denormalized columns

---

## Phase 2: MCP Tools

### New Tool Files

All tools go in `src/tools/skills/` directory:

| File | Tool Name | Purpose |
|------|-----------|---------|
| `skill-create.ts` | `skill-create` | Create a personal skill from SKILL.md content |
| `skill-update.ts` | `skill-update` | Update a skill's content |
| `skill-delete.ts` | `skill-delete` | Delete a skill |
| `skill-get.ts` | `skill-get` | Get full skill content by ID or name |
| `skill-list.ts` | `skill-list` | List available skills (filterable) |
| `skill-search.ts` | `skill-search` | Search skills by keyword |
| `skill-install.ts` | `skill-install` | Install/assign a skill to an agent |
| `skill-uninstall.ts` | `skill-uninstall` | Remove skill from an agent |
| `skill-install-remote.ts` | `skill-install-remote` | Fetch remote skill from GitHub |
| `skill-sync-remote.ts` | `skill-sync-remote` | Check/update remote skills from GitHub |
| `skill-publish.ts` | `skill-publish` | Publish personal skill to swarm scope (creates approval task) |

### Tool Specifications

#### `skill-create`

```typescript
params: {
  content: string;        // Full SKILL.md content (frontmatter + body)
  scope?: "agent" | "swarm";  // Default: "agent"
}
```

- Parses frontmatter to extract name, description, and other metadata
- Validates required fields (name, description)
- Sets `ownerAgentId` to the calling agent
- If `scope: "swarm"`, creates an approval task for the lead instead of immediately publishing
- Returns the created skill object

#### `skill-update`

```typescript
params: {
  skillId?: string;       // By ID
  name?: string;          // Or by name (resolved for calling agent)
  content?: string;       // New SKILL.md content (re-parses frontmatter)
  isEnabled?: boolean;    // Toggle enabled/disabled
}
```

- Only the owning agent or lead can update
- Re-parses frontmatter if content is changed
- Bumps version counter

#### `skill-delete`

```typescript
params: {
  skillId?: string;
  name?: string;
}
```

- Only owning agent or lead can delete
- Cascades to agent_skills (ON DELETE CASCADE)

#### `skill-get`

```typescript
params: {
  skillId?: string;
  name?: string;
}
```

- Returns full skill object including content
- Name resolution: checks agent's own skills first (personal precedence), then swarm, then global

#### `skill-list`

```typescript
params: {
  type?: "remote" | "personal";
  scope?: "global" | "swarm" | "agent";
  agentId?: string;         // Filter by owning agent
  installedOnly?: boolean;  // Only show skills installed for calling agent
  includeContent?: boolean; // Default false (content can be large)
}
```

#### `skill-search`

```typescript
params: {
  query: string;
  limit?: number;  // Default 20
}
```

- LIKE search on name and description columns

#### `skill-install`

```typescript
params: {
  skillId: string;
  agentId?: string;  // Default: calling agent. Lead can install for others.
}
```

- Creates entry in `agent_skills`
- Validates skill exists and is enabled

#### `skill-uninstall`

```typescript
params: {
  skillId: string;
  agentId?: string;
}
```

#### `skill-install-remote`

```typescript
params: {
  sourceRepo: string;      // e.g., "vercel-labs/skills"
  sourcePath?: string;     // e.g., "skills/nextjs"
  scope?: "global" | "swarm";  // Default: "global"
  isComplex?: boolean;     // If true, registers for npx install instead of DB storage
}
```

- For simple skills: fetches SKILL.md via GitHub raw content API, parses, stores in DB
- For complex skills: stores metadata only (sourceRepo, sourcePath, isComplex=true), content empty
- Sets `type: "remote"`, `sourceUrl`, `sourceHash` from GitHub tree SHA
- Uses `gh api` or raw fetch to retrieve content
- **Permissions:** Only lead agents or `skill-install-remote` MCP tool callers can create global-scope skills. Swarm-scope skills require lead approval (same as `skill-publish`)

#### `skill-sync-remote`

```typescript
params: {
  skillId?: string;  // Sync specific skill, or all remote skills if omitted
  force?: boolean;   // Force re-fetch even if hash matches
}
```

- For each remote simple skill: compare `sourceHash` with current GitHub tree SHA
- If different: fetch updated content, parse frontmatter, update DB, bump version
- For complex skills: run `npx skills check` and `npx skills update` if needed
- Updates `lastFetchedAt` timestamp

#### `skill-publish`

```typescript
params: {
  skillId: string;
}
```

- Only works on personal (`type: "personal"`) skills owned by the calling agent
- Creates a `send-task` to the lead agent with type "skill-approval"
- Task description includes skill name, description, and content for review
- Lead approves → scope changes to "swarm"; Lead rejects → no change
- Returns the created task ID so agent can track approval

### HTTP/REST Endpoints

**File:** `src/http/skills.ts`

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/skills` | List skills (query params: type, scope, agentId, enabled, search) |
| `GET` | `/api/skills/:id` | Get skill by ID |
| `POST` | `/api/skills` | Create a skill |
| `PUT` | `/api/skills/:id` | Update a skill |
| `DELETE` | `/api/skills/:id` | Delete a skill |
| `POST` | `/api/skills/:id/install` | Install skill for an agent (body: { agentId }) |
| `DELETE` | `/api/skills/:id/install/:agentId` | Uninstall skill for an agent |
| `POST` | `/api/skills/install-remote` | Install a remote skill from GitHub |
| `POST` | `/api/skills/sync-remote` | Trigger remote skill sync |
| `POST` | `/api/skills/sync-filesystem` | Sync installed skills to agent's filesystem (called by runner.ts via HTTP) |
| `GET` | `/api/agents/:id/skills` | Get all skills installed for an agent |

All endpoints use `route()` factory from `src/http/route-def.ts` and are registered in `src/http/index.ts`.

---

## Phase 3: Filesystem Bridge

### Sync Logic

**File:** `src/be/skill-sync.ts`

```typescript
export async function syncSkillsToFilesystem(
  agentId: string,
  harnessType: "claude" | "cursor" | "both"
): Promise<{ synced: number; errors: string[] }>
```

**For simple skills (content in DB):**

1. Query `getAgentSkills(agentId, activeOnly=true)` — gets all active, enabled skills
2. For each simple skill (`isComplex = false`):
   - Write to `~/.claude/skills/<skill.name>/SKILL.md` with `skill.content` verbatim
   - If `harnessType` includes cursor: also write to `~/.cursor/skills/<skill.name>/SKILL.md`
3. Clean up: remove any `~/.claude/skills/<name>/` directories for skills no longer installed

**For complex skills (`isComplex = true`):**

1. Run `npx skills add <sourceRepo> -a claude-code -g -y`
2. If cursor: also add `-a cursor`
3. `npx skills` handles the full directory structure

### Name Conflict Resolution & Precedence

When an agent has both a personal skill and a remote skill with the same name:
- **Personal wins** (per Taras's decision #1)
- The filesystem gets the personal skill's content
- The remote skill still exists in DB but is shadowed for that agent

**SQL ordering in `getAgentSkills`:** The query uses precedence ordering to ensure personal skills come first:

```sql
SELECT s.*, as2.isActive, as2.installedAt
FROM skills s
JOIN agent_skills as2 ON s.id = as2.skillId
WHERE as2.agentId = ?
  AND (? IS NULL OR as2.isActive = ?)
  AND s.isEnabled = 1
ORDER BY
  CASE WHEN s.type = 'personal' THEN 0 ELSE 1 END,
  s.name
```

**Deduplication in application layer:** After the query, `getAgentSkills` deduplicates by name — keeping only the first occurrence (highest precedence). This means callers always get at most one skill per name:

```typescript
function deduplicateByName(skills: SkillWithInstallInfo[]): SkillWithInstallInfo[] {
  const seen = new Set<string>();
  return skills.filter(s => {
    if (seen.has(s.name)) return false;
    seen.add(s.name);
    return true;
  });
}
```

**Filesystem sync deduplication:** The sync function iterates the already-deduplicated list, so it writes only the highest-precedence skill per name to `~/.claude/skills/<name>/SKILL.md`. No filesystem-level dedup is needed.

### Integration Points

#### Docker Entrypoint (`docker-entrypoint.sh`)

Add a skill sync step after agent registration and repo clone (~line 389 in current entrypoint), before startup scripts (~line 392) and before starting the runner:

```bash
# --- Skill sync ---
echo "[entrypoint] Syncing skills to filesystem..."
SKILLS_RESPONSE=$(curl -s -H "Authorization: Bearer $API_KEY" \
  -H "X-Agent-ID: $AGENT_ID" \
  "$MCP_BASE_URL/api/agents/$AGENT_ID/skills")

# Parse and write simple skills
echo "$SKILLS_RESPONSE" | jq -r '.skills[] | select(.isComplex == false) | @base64' | while read skill_b64; do
  SKILL_NAME=$(echo "$skill_b64" | base64 -d | jq -r '.name')
  SKILL_CONTENT=$(echo "$skill_b64" | base64 -d | jq -r '.content')

  mkdir -p "$HOME/.claude/skills/$SKILL_NAME"
  echo "$SKILL_CONTENT" > "$HOME/.claude/skills/$SKILL_NAME/SKILL.md"

  # Cursor/Pi compatibility
  mkdir -p "$HOME/.cursor/skills/$SKILL_NAME"
  cp "$HOME/.claude/skills/$SKILL_NAME/SKILL.md" "$HOME/.cursor/skills/$SKILL_NAME/SKILL.md"
done

# Install complex remote skills via npx
echo "$SKILLS_RESPONSE" | jq -r '.skills[] | select(.isComplex == true) | .sourceRepo' | while read repo; do
  if [ -n "$repo" ]; then
    npx skills add "$repo" -a claude-code -a cursor -g -y 2>&1 || echo "[entrypoint] Warning: failed to install $repo"
  fi
done

echo "[entrypoint] Skill sync complete"
```

#### Runner (`src/commands/runner.ts`)

Re-sync skills before each new session (in case skills were added/removed via MCP tools while the agent was running). **This runs in worker context, so it must use an HTTP call** (not a direct import from `src/be/`) to respect the Worker/API DB boundary:

```typescript
// Before starting a new Claude session — uses existing mcpBaseUrl + apiKey pattern from runner.ts
await fetch(`${mcpBaseUrl}/api/skills/sync-filesystem`, {
  method: "POST",
  headers: { "Authorization": `Bearer ${apiKey}`, "X-Agent-ID": agentId }
});
```

The API endpoint handles the actual filesystem sync server-side and returns the result.

---

## Phase 4: System Prompt Integration

### Progressive Disclosure in Base Prompt

**File:** `src/prompts/base-prompt.ts`

Add a skill section to the system prompt that lists installed skills with name + description only (~100 tokens per skill):

```typescript
// In the prompt building function — follows existing mcpBaseUrl + apiKey pattern from runner.ts
async function buildSkillSection(agentId: string, mcpBaseUrl: string, apiKey: string): Promise<string> {
  const res = await fetch(`${mcpBaseUrl}/api/agents/${agentId}/skills`, {
    headers: { "Authorization": `Bearer ${apiKey}`, "X-Agent-ID": agentId }
  });
  const { skills } = await res.json() as { skills: SkillWithInstallInfo[] };
  if (skills.length === 0) return "";

  const summaries = skills
    .filter(s => s.isActive && s.isEnabled)
    .map(s => `- /${s.name}: ${s.description}`)
    .join("\n");

  return `\n## Installed Skills\n\nThe following skills are available. Use the Skill tool to invoke them by name.\n\n${summaries}\n`;
}
```

**Important:** This runs in worker context (runner.ts), so it fetches skills via HTTP from the API, not direct DB access. The API endpoint `GET /api/agents/:id/skills` provides the data.

### Skill Activation

When an agent invokes a skill via the Skill tool (e.g., `/my-skill`), the harness loads the full SKILL.md from the filesystem (`~/.claude/skills/my-skill/SKILL.md`). This is already handled by Claude Code and Cursor natively — no additional code needed on our side.

For skills that aren't on the filesystem (e.g., if sync hasn't run), the system prompt section provides a fallback: the agent sees the skill name and can request it via `skill-get` MCP tool.

---

## Phase 5: UI (new-ui)

### New Pages

#### Skills List Page (`/skills`)

**File:** `new-ui/src/pages/skills/page.tsx`

**Router registration:** Add route in `new-ui/src/router.tsx` for `/skills`.

- Table component listing all skills
- Columns: Name, Type (badge), Scope (badge), Description, Owner, Status (toggle), Installed count, Last Updated
- Filters: Type dropdown, Scope dropdown, Status toggle, Owner selector
- "Add Skill" button → opens modal with two tabs: "From GitHub" / "Create Manual"
- Bulk actions: Enable/Disable, Delete
- Row click → navigates to detail page

#### Skill Detail Page (`/skills/[id]`)

**File:** `new-ui/src/pages/skills/[id]/page.tsx`

**Router registration:** Add route in `new-ui/src/router.tsx` for `/skills/:id`.

- Header: Name, type badge, scope badge, enabled toggle
- Three tabs:
  1. **Content**: Rendered SKILL.md with raw/edit toggle. Edit mode = textarea with save button
  2. **Metadata**: Parsed frontmatter fields, source info (for remote), version, timestamps
  3. **Agents**: Table of agents with this skill, install/uninstall buttons per agent
- Actions sidebar: Edit, Delete, Duplicate, Publish (personal→swarm), Install for Agent dropdown

#### Agent Skills Tab

**File:** Modify `new-ui/src/pages/agents/[id]/page.tsx`

**Router registration:** Ensure `/agents/:id` route in `new-ui/src/router.tsx` supports the new Skills tab (no new route needed — the tab is within the existing agent detail page).

- Add "Skills" tab to agent detail page
- Shows installed skills for that agent with active/inactive toggle
- "Install Skill" button → skill picker modal
- Uninstall button per skill

### API Integration

All UI components call the REST endpoints from Phase 2:
- `GET /api/skills` for listing
- `GET /api/skills/:id` for detail
- `POST /api/skills` for creation
- `PUT /api/skills/:id` for updates
- `DELETE /api/skills/:id` for deletion
- `POST /api/skills/:id/install` for agent assignment
- `GET /api/agents/:id/skills` for agent's skills tab

### Add Skill Modals

**From GitHub modal:**
1. Text input for GitHub repo URL (e.g., `vercel-labs/skills`)
2. Optional path input (e.g., `skills/nextjs`)
3. "Complex (multi-file)" checkbox
4. Scope selector (global/swarm)
5. "Preview" button → fetches and shows SKILL.md content
6. "Install" button → calls `POST /api/skills/install-remote`

**Create Manual modal:**
1. Markdown editor pre-filled with SKILL.md template:
   ```markdown
   ---
   name: my-skill
   description: What this skill does
   allowed-tools: Bash
   ---

   ## Instructions

   Your instructions here...
   ```
2. Scope selector (agent/swarm)
3. Owner agent selector (for leads)
4. "Validate" button → parses frontmatter, shows errors
5. "Save" button → calls `POST /api/skills`

---

## Phase 6: Advanced Features

### Remote Skill Refresh

**Approach:** Daily schedule + on-demand button.

- Create a schedule (`create-schedule`) that runs `skill-sync-remote` daily
- UI "Refresh" button on skills list page triggers `POST /api/skills/sync-remote` on-demand
- No complex cron infrastructure — reuse existing schedule system

### Skill Approval Workflow (Publishing)

When an agent calls `skill-publish`:
1. Creates a task for the lead with tag `skill-approval`
2. Task description includes: skill name, description, full content, requesting agent
3. Lead reviews and either:
   - Approves: calls `skill-update` to change scope to `swarm`
   - Rejects: closes the task with a rejection reason
4. The requesting agent is notified via task completion

### OpenAPI Spec Update

After implementing all REST endpoints:
1. Import all route definitions in `scripts/generate-openapi.ts`
2. Run `bun run docs:openapi` to regenerate `openapi.json`
3. Commit the updated spec

---

## Implementation Order

| Step | Files Changed/Created | Dependencies |
|------|----------------------|--------------|
| 1. Migration | `src/be/migrations/019_skills.sql` | None |
| 2. Types | `src/types.ts` | None |
| 3. Frontmatter parser | `src/be/skill-parser.ts` | None |
| 4. DB functions | `src/be/db.ts` | Steps 1-3 |
| 5. MCP tools | `src/tools/skills/*.ts`, `src/tools/tool-config.ts` | Step 4 |
| 6. HTTP endpoints | `src/http/skills.ts`, `src/http/index.ts` | Step 4 |
| 7. Filesystem sync | `src/be/skill-sync.ts` | Step 4 |
| 8. Docker entrypoint | `docker-entrypoint.sh` | Step 6 |
| 9. System prompt | `src/prompts/base-prompt.ts` | Step 6 |
| 10. UI - Skills pages | `new-ui/src/pages/skills/**`, `new-ui/src/router.tsx` | Step 6 |
| 11. UI - Agent skills tab | `new-ui/src/pages/agents/[id]/page.tsx` | Step 6 |
| 12. OpenAPI spec | `openapi.json`, `scripts/generate-openapi.ts` | Step 6 |
| 13. Tests | `src/tests/skills.test.ts` | Steps 4-6 |
| 14. Remote sync schedule | Uses existing schedule system | Step 5 |

### PR Strategy

Split into 4-5 PRs for reviewability:

1. **PR 1a — Data layer** (Steps 1-4): Migration, types, frontmatter parser, DB functions
2. **PR 1b — API layer** (Steps 5-6): MCP tools, HTTP endpoints (depends on PR 1a)
3. **PR 2 — Filesystem bridge + integration** (Steps 7-9): Sync logic, entrypoint, system prompt
4. **PR 3 — UI** (Steps 10-12): Skills pages, agent skills tab, router.tsx registration, OpenAPI
5. **PR 4 — Tests + advanced** (Steps 13-14): Unit tests, remote sync schedule

---

## Testing Strategy

### Unit Tests

**File:** `src/tests/skills.test.ts`

- Test skill CRUD operations (create, read, update, delete)
- Test frontmatter parsing (valid, invalid, missing required fields)
- Test `agent_skills` junction (install, uninstall, toggle)
- Test name conflict resolution (personal precedence over remote)
- Test scope filtering (agent can only see own + swarm + global)
- Test publish workflow (creates approval task)
- Use isolated SQLite DB per test suite (standard pattern)

### Integration Tests

- MCP tool tests via HTTP session handshake
- Filesystem sync verification (write skills, check files exist)
- Docker entrypoint E2E (start container, verify skills written to filesystem)

### Pre-PR Checks

Per CLAUDE.md:
```bash
bun run lint:fix
bun run tsc:check
bun test
bash scripts/check-db-boundary.sh
```

---

## Key Architecture Notes

### Worker/API DB Boundary

Per the codebase's architecture invariant, worker code never imports from `src/be/db.ts`. All skill operations from workers go through HTTP:

- **Worker side** (`runner.ts`, `base-prompt.ts`): Fetches skills via `GET /api/agents/:id/skills`
- **API side** (`src/tools/skills/`, `src/http/skills.ts`): Directly queries DB via `db.ts` functions

The filesystem sync function (`skill-sync.ts`) lives in `src/be/` (API side) but is also called from `docker-entrypoint.sh` via the REST API. The runner calls the API endpoint to trigger sync, not the function directly.

### Existing Skill Infrastructure

The codebase already has:
- `plugin/pi-skills/` — 12 pi-mono skills (generated from `plugin/commands/`)
- `plugin/skills/artifacts/` — artifact creation skill
- `.claude/skills/swarm-local-e2e/` — local E2E testing skill

The new skill system is additive — it doesn't replace these built-in skills. Built-in skills continue to be discovered by harnesses from their existing filesystem locations. DB-managed skills are a separate, dynamic layer on top.

### Frontmatter Field Mapping

| SKILL.md Frontmatter | DB Column | Notes |
|----------------------|-----------|-------|
| `name` | `name` | Required, unique per scope+owner |
| `description` | `description` | Required |
| `allowed-tools` | `allowedTools` | Comma-separated |
| `model` | `model` | Model override |
| `effort` | `effort` | Effort level override |
| `context` | `context` | "fork" = isolated subagent |
| `agent` | `agent` | Subagent type |
| `disable-model-invocation` | `disableModelInvocation` | Boolean |
| `user-invocable` | `userInvocable` | Boolean, default true |

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Filesystem sync race conditions | Sync is single-threaded per agent, runs before session start |
| `npx skills` network failures | Wrap in `\|\| true`, log warnings, skills still work from DB |
| Large skill content in DB | Content is just text (SKILL.md), typically < 10KB each |
| Name collisions between agents | Unique index on (name, scope, ownerAgentId) prevents duplicates |
| Breaking existing skills | New system is additive; existing plugin/pi-skills/ untouched |
| Worker importing DB code | `check-db-boundary.sh` enforced in CI |
| Mid-session skill updates | **Known v1 limitation:** Skills are synced to filesystem before session start. If a skill is installed/updated mid-session, the running Claude session won't see the change until the next session. Mitigation: the `skill-get` MCP tool provides real-time access to skill content as a fallback. |
