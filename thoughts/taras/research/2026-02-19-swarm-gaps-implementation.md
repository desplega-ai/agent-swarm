---
date: 2026-02-19T22:10:00Z
researcher: Claude
git_commit: e10703529a2508b9070d7bdfc61db2a2e8e4b241
branch: main
repository: agent-swarm
topic: "Swarm Gaps Implementation Research: Identity, Memory, Sessions, Repos, Auto-improvement, Env Management"
tags: [research, architecture, identity, memory, sessions, repos, auto-improvement, env-management, agent-native]
status: complete
autonomy: verbose
last_updated: 2026-02-20
last_updated_by: Claude
---

# Research: Swarm Gaps Implementation

**Date**: 2026-02-19
**Researcher**: Claude
**Git Commit**: e107035
**Branch**: main

## Research Question

Based on the agent-native architecture research (`thoughts/taras/research/2026-02-19-agent-native-swarm-architecture.md`), what changes are needed in the agent-swarm codebase to implement 6 identified gaps: (1) worker identity files, (2) memory system with vector search, (3) session attachment, (4) repos knowledge, (5) auto-improvement scripts, (6) env management API?

## Summary

The agent-swarm codebase has strong infrastructure scaffolding (hooks, DB migrations, MCP tools, Docker volumes, shared filesystem) but lacks the connective tissue to make agents persistent, knowledge-accumulating entities. Each of the 6 gaps maps to concrete changes in existing files -- no major architectural rewrites needed.

**Identity** (Gap 1) requires new DB columns (`soulMd`, `identityMd`) on the `agents` table, with identity/soul content injected via `--append-system-prompt` (immutable persona) while `~/.claude/CLAUDE.md` remains the agent's mutable personal notes. Generation templates should include behavioral instructions ("embody this persona", "this file is yours to evolve").

**Memory** (Gap 2) is the largest gap. Today, data accumulates across 7 storage subsystems with zero cross-system search. Implementation requires: (a) a new `agent_memory` table with sqlite-vec for vector search, (b) OpenAI embeddings API integration (`text-embedding-3-small` at 512 dims), (c) MCP tools for search and retrieval (`memory-search`, `memory-get`), (d) file-based auto-indexing via hooks (files written to `{personal|shared}/memory/` are automatically indexed), and (e) automatic session summarization at `Stop` and `PreCompact` hooks.

**Session attachment** (Gap 3) is surprisingly tractable. The runner currently uses `-p` (one-shot prompt mode) exclusively and never uses `--resume`/`--continue`. Adding a `parentTaskId` field to `agent_tasks`, capturing Claude CLI session IDs from stream-json output, and switching from `-p` to `--resume` for child tasks would enable session continuity. The empty `PreCompact` hook can inject goal reminders.

**Repos knowledge** (Gap 4) needs a new `swarm_repos` config table, auto-clone logic in the entrypoint or runner, and CLAUDE.md composition that appends repo-level CLAUDE.md content. The `githubRepo` field already exists on tasks/epics but is unused for workspace setup.

**Auto-improvement** (Gap 5) can leverage the existing startup script mechanism (`/workspace/start-up.*` in docker-entrypoint.sh). Since the startup script may already exist via Docker volume mount, the DB-stored script content would be *prepended* to the existing mounted file rather than replacing it. This combines operator-managed base setup (mount) with agent-learned additions (DB).

**Env management** (Gap 6) requires a new `config` table with `scope` (global/agent/repo) and `key`/`value` columns, REST API endpoints, UI components, and injection into Docker env at container start or via MCP tool responses.

## Detailed Findings

### Gap 1: Worker Identity (SOUL.md / IDENTITY.md)

#### What Exists Today

Agent profiles are stored in the `agents` table (`src/be/db.ts:48-59`) with identity fields: `name`, `description`, `role`, `capabilities`, `claudeMd`. The `claudeMd` field (64KB TEXT, added at line 499) holds the only persistent per-agent instructions.

The identity lifecycle:
1. **Registration** (`src/tools/join-swarm.ts:99-112`): `generateDefaultClaudeMd()` creates a template with name/role/capabilities headers plus empty Learnings/Preferences/Important Context sections (`src/be/db.ts:2129-2169`).
2. **Session start** (`src/hooks/hook.ts:496-508`): Agent's `claudeMd` is fetched from DB via `GET /me` and written to `~/.claude/CLAUDE.md`.
3. **Session end** (`src/hooks/hook.ts:574-581`): `syncClaudeMdToServer()` reads `~/.claude/CLAUDE.md` and PUTs it back to DB.
   - **Consideration**: Rather than only syncing on Stop, we could add a `PostToolUse` hook for Edit/Write operations targeting `~/.claude/CLAUDE.md` to persist changes in real-time. This would prevent data loss if a session crashes before the Stop hook fires.
4. **Manual update**: `update-profile` MCP tool (`src/tools/update-profile.ts:26-31`) or `PUT /api/agents/:id/profile` (`src/http.ts:968-1048`).

The base system prompt (`src/prompts/base-prompt.ts:1-5`) injects only the structural role and agent ID:
```
You are part of an agent swarm, your role is: {role} and your unique identifier is {agentId}.
```
The agent's `name`, `description`, `role` field (from profile), and `capabilities` are NOT in the system prompt.

#### What's Missing

- No `soulMd` or `identityMd` DB columns
- No SOUL.md or IDENTITY.md files written to the filesystem
- No behavioral instructions telling the agent to "embody" its persona
- No self-evolution encouragement ("this file is yours to evolve")
- The base system prompt has no awareness of CLAUDE.md content
- The `--append-system-prompt` path and `~/.claude/CLAUDE.md` path are completely independent

#### What Would Need to Change

**DB Schema**: Add `soulMd TEXT` and `identityMd TEXT` columns to `agents` table using the existing try-catch ALTER TABLE migration pattern (like `claudeMd` at line 497-502). Or alternatively, keep them as structured sections within `claudeMd` to avoid schema changes.

**Hook lifecycle**: The `SessionStart` handler (`hook.ts:496-508`) currently writes only `claudeMd` to `~/.claude/CLAUDE.md`. It would need to compose the final file from multiple sources: identity + soul + CLAUDE.md + (later) repo CLAUDE.md.

**Generation templates**: New functions `generateDefaultSoulMd()` and `generateDefaultIdentityMd()` called alongside `generateDefaultClaudeMd()` in `join-swarm.ts:99-112`. The SOUL.md template should include behavioral directives ("Embody this persona", "This file is yours to evolve").

**Profile sync**: `syncClaudeMdToServer()` (`hook.ts:238-261`) would need to either parse the composed file back into sections, or track sections with markers for extraction. The `PUT /api/agents/:id/profile` endpoint would need new fields.

**Key design decision**: Split content across two injection points to avoid duplication:
- **`--append-system-prompt`** (via `getBasePrompt()`): Inject soul, identity, and worker info here. This is read-only context the agent shouldn't edit -- persona, behavioral directives, role definition. The runner already fetches agent info for registration, so this data is available at spawn time.
- **`~/.claude/CLAUDE.md`**: Keep this for the agent's personal mutable notes only (Learnings, Preferences, Important Context). This is what the agent reads and edits during sessions, synced back on Stop.

This avoids repeating content across both injection points and keeps a clean separation: system prompt = who you are (immutable), CLAUDE.md = what you've learned (mutable).

### Gap 2: Memory System (FS + sqlite-vec + OpenAI Embeddings)

#### What Exists Today

Agent data is scattered across 7 storage subsystems with no unified search:

| Store | Location | Searchable? |
|-------|----------|------------|
| `agents.claudeMd` | SQLite, 64KB per agent | No (always in context) |
| `agent_tasks.progress` / `output` | SQLite, unbounded TEXT | Only by task ID |
| `agent_log` | SQLite, indexed by agentId/taskId/eventType | Only by specific lookups |
| `session_logs` | SQLite, raw CLI output lines | Only by taskId/sessionId |
| `session_costs` | SQLite, cost tracking | Only by sessionId/agentId |
| `/workspace/personal/` | Docker volume, per-agent | Manual grep by agent |
| `/workspace/shared/thoughts/` | Docker volume, shared | Manual grep by agent |

The base prompt (`src/prompts/base-prompt.ts:200-205`) suggests agents create `memory.txt` or `memory.db` in their personal directory, but provides no automation or tools.

#### DB Infrastructure Available

- `bun:sqlite` Database class supports `loadExtension(path)` for SQLite extensions
- No `loadExtension` calls exist in the codebase today
- WAL mode and transactions are already used extensively
- Migration pattern: `try { ALTER TABLE ADD COLUMN } catch {}` for idempotent column additions, `CREATE TABLE IF NOT EXISTS` for new tables
- No `openai` package in `package.json` -- would need to be added

#### sqlite-vec Compatibility with Bun

The `sqlite-vec` npm package officially supports `bun:sqlite`. The `sqliteVec.load(db)` function auto-discovers prebuilt platform-specific binaries -- no manual `.so`/`.dylib` management needed. Install via `bun add sqlite-vec`.

**macOS caveat**: Apple ships a proprietary SQLite build that disables extension loading. On macOS dev machines, you must `brew install sqlite` and call `Database.setCustomSQLite()` before creating any Database instance. On Linux/Docker, no extra setup needed.

```typescript
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";

// macOS only: Apple's SQLite disables extensions
if (process.platform === "darwin") {
  const sqlitePath = Bun.$`brew --prefix sqlite`.text().trim() + "/lib/libsqlite3.dylib";
  Database.setCustomSQLite(sqlitePath);
}

const db = new Database("./agent-swarm-db.sqlite");
sqliteVec.load(db);
```

**sqlite-vec API** (vec0 virtual table):
```sql
-- Create vector table with metadata and auxiliary columns
CREATE VIRTUAL TABLE vec_memory USING vec0(
  memory_id integer primary key,
  embedding float[512],
  scope text,              -- metadata: 'agent' or 'swarm'
  +agent_id text,          -- auxiliary: optional, NULL for swarm-level
  +task_id text,           -- auxiliary: link to source task
  +name text,              -- auxiliary: human-readable label (e.g. "auth header fix")
  +content text,           -- auxiliary: the memory content
  +source text             -- auxiliary: 'task_completion', 'file_index', 'session_summary', 'manual'
);

-- KNN search (agent-scoped: own memories + swarm memories)
SELECT memory_id, name, content, source, task_id, distance
FROM vec_memory
WHERE embedding MATCH ?
  AND k = 20
  AND (scope = 'swarm' OR agent_id = 'abc-123')
ORDER BY distance
LIMIT 10;

-- KNN search (swarm-wide only)
SELECT memory_id, name, content, source, distance
FROM vec_memory
WHERE embedding MATCH ?
  AND k = 20
  AND scope = 'swarm'
ORDER BY distance
LIMIT 10;
```

Vectors are passed as `Float32Array` from JS. Performance: ~75ms for 100K vectors at 1536 dimensions.

**Alternative for small scale (<10K vectors)**: Store embeddings as BLOBs in a regular SQLite table and compute cosine similarity in JS. Zero dependencies, works identically on macOS and Linux. O(n) brute force but fine for agent-swarm's likely scale.

#### OpenAI Embeddings API

| Model | Dimensions | Price | Notes |
|-------|-----------|-------|-------|
| `text-embedding-3-small` | 1536 (default), supports `dimensions` param for reduction | $0.02/1M tokens | **Recommended** |
| `text-embedding-3-large` | 3072 (default) | $0.13/1M tokens | Best quality |

Both v3 models support Matryoshka dimension shortening via a `dimensions` parameter. `text-embedding-3-small` at 512 dimensions is likely sufficient for agent memory search -- cheap, fast, and 512 dims is plenty for task/message similarity.

```typescript
import OpenAI from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function getEmbedding(text: string): Promise<Float32Array> {
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text.replace(/[\n\r]/g, " "),
    dimensions: 512,  // 3x smaller than default, still good quality
  });
  return new Float32Array(response.data[0].embedding);
}
```

**Practical cost**: Indexing 10,000 documents of ~500 tokens each (5M tokens) costs $0.10.

#### What Would Need to Change

**New `agent_memory` table**: Structured memory entries with fields like `id`, `agentId`, `scope` (agent/swarm), `content`, `summary`, `embedding` (BLOB for vector), `source` (task_completion/manual/session_summary), `sourceTaskId`, `tags`, `createdAt`, `accessedAt`.

**sqlite-vec setup**: Add to `Dockerfile.worker` and API server dependencies. Load extension in `initDb()` after database creation (`src/be/db.ts:33`).

**OpenAI embeddings integration**: Add `openai` package. Create an embedding utility function. Called when saving memories and when searching.

**New MCP tools** (following pattern in `src/tools/`):
- `memory-search`: Takes a query string, generates embedding, runs hybrid BM25+vector search against `agent_memory`. Returns summaries with memory IDs.
- `memory-get`: Takes a memory ID, returns full content details (for when search results need deeper inspection).

No explicit `memory-save` MCP tool. Instead, memory ingestion happens via two mechanisms:

**File-based auto-indexing** (OpenClaw-inspired):
- Any files written to `{personal|shared}/memory/` or `shared/thoughts/` are automatically indexed.
- A `PostToolUse` hook on Write/Edit operations checks if the target path matches these directories. If so, it queues the file for embedding and indexing into `agent_memory`.
- This lets agents save memories naturally by writing markdown files (like OpenClaw's `memory/*.md` pattern) without needing a special tool.

**Automatic session summarization**:
- `Stop` hook (`hook.ts:566-594`): After syncing CLAUDE.md, extract session summary from `transcript_path`, generate embedding, save to `agent_memory` with `source: 'session_summary'` and `task_id` linked.
- `PreCompact` hook (`hook.ts:510-512`): Currently empty. Flush important context to memory before context window compaction.
- Task completion: When `store-progress` is called with `status: "completed"`, the task output is also indexed into memory with `source: 'task_completion'`.

**Swarm vs. worker scoping**: Each memory entry needs a `scope` field. Agent-level memories are only searchable by that agent. Swarm-level memories are searchable by all agents. The search tool would filter by `agentId` for agent scope and include all swarm-scoped entries.

### Gap 3: Session Attachment (Parent Task Resume)

#### What Exists Today

**Task execution is one-shot**: The runner (`src/commands/runner.ts:959-1236`) spawns Claude with `-p` flag (prompt mode), meaning every task is a fresh, isolated session. No `--resume` or `--continue` flags are ever used.

**Task schema has no parent linkage**: The `agent_tasks` table (`src/be/db.ts:62-88`) has `epicId` for project grouping and `dependsOn` for ordering, but no `parentTaskId` for session hierarchy. The `CreateTaskOptions` interface (`src/be/db.ts:1760-1782`) doesn't include it either.

**Current resume is prompt-based only**: When a paused task is resumed (`buildResumePrompt()` at `runner.ts:247-272`), the system starts a fresh Claude session with the previous `progress` text injected into the prompt. All conversation history is lost.

**PreCompact hook is empty** (`hook.ts:510-512`): No-op with comment "Covered by SessionStart hook."

**No Claude session ID tracking**: The runner tracks its own `sessionId` (generated at `runner.ts:1271`) for log grouping, but never captures Claude CLI's internal session ID from its stream-json output.

#### What Would Need to Change

**DB schema**:
- Add `parentTaskId TEXT` column to `agent_tasks` (migration pattern: try/catch ALTER TABLE)
- Add `claudeSessionId TEXT` column to `agent_tasks` to store Claude CLI's session ID

**Claude session ID capture**: Confirmed -- stream-json output includes `session_id` in two places:
- **Init message** (first line): `{"type":"system","subtype":"init","session_id":"<uuid>",...}` -- **prefer this**, as the final result message sometimes fails to emit ([Issue #1920](https://github.com/anthropics/claude-code/issues/1920))
- **Result message** (last line): `{"type":"result","session_id":"<uuid>","cost_usd":...}`

The runner currently only parses `json.type === "result"` at `runner.ts:1050`. Add a new branch:
```typescript
if (json.type === "system" && json.subtype === "init" && json.session_id) {
    // Store json.session_id for this task in DB
}
```

**`--resume` works with `-p`**: Officially supported ([docs](https://code.claude.com/docs/en/headless)):
```bash
session_id=$(claude -p "Start a review" --output-format json | jq -r '.session_id')
claude -p "Continue that review" --resume "$session_id"
```

**Critical caveat**: Each `--resume` invocation generates a **new** session ID (by design, [Issue #4926](https://github.com/anthropics/claude-code/issues/4926)). You must always capture the latest session ID from each task's output and chain from that, not from the original.

**`send-task` tool extension**: Add `parentTaskId` parameter to `src/tools/send-task.ts:21-49` and pass it through to `createTaskExtended()`.

**Runner spawn logic**: When a task has `parentTaskId`:
1. Look up the parent task's `claudeSessionId` from DB
2. Add `--resume <claudeSessionId>` to the command args alongside `-p` (both flags work together)
3. Capture the **new** session ID from this task's init message and store it
4. Fallback: if parent's `claudeSessionId` is missing (e.g., old task), fall back to fresh session with progress injection (current behavior)

**PreCompact hook**: Add goal reminder injection. The hook receives `session_id` and can read the current task's description from the task file (`TASK_FILE` env var). Inject a reminder like "Remember: your current goal is [task description]" into the context.

**Compact tolerance**: Accept that context compaction will happen for long-running sessions. The PreCompact hook ensures the goal survives compaction. The memory system (Gap 2) can persist important findings before compaction.

### Gap 4: Repos Knowledge (Auto-Clone + CLAUDE.md Linking)

#### What Exists Today

**Docker workspace structure**: `/workspace/personal/` (per-agent volume) and `/workspace/shared/` (shared volume). No `/workspace/repos/` or repo management concept. Cloned repos go wherever the agent decides during task execution.

**GitHub auth is ready**: `docker-entrypoint.sh:121-142` configures `gh auth setup-git` and git config. Workers can clone private repos.

**`githubRepo` field exists but is underused**: The `agent_tasks` table has `githubRepo TEXT` (set by GitHub webhook handlers at `src/github/handlers.ts:109`). The `send-task` MCP tool does NOT expose this field (see `src/tools/send-task.ts:21-49`). Epics also have `githubRepo` and `githubMilestone` fields (`src/types.ts:332-333`).

**Lead base prompt mentions clone**: `src/prompts/base-prompt.ts:110,136` include task templates with `git clone {repo_url}` as a text instruction for leads to include in tasks. This is not automation.

**Startup script mechanism**: `docker-entrypoint.sh:203-300` looks for `/workspace/start-up.*` and executes it. No startup script exists in the committed codebase, but this is a natural hook for repo preparation.

**No config table**: There's no settings/config table in the DB. The only place env-like data is stored is the `services.env` JSON column (per-service PM2 env vars).

#### What Would Need to Change

**New `swarm_repos` table**: Single table -- all agents get access to all registered repos (no junction table needed). Fields: `id`, `url`, `name`, `defaultBranch`, `claudeMdContent` (cached), `autoClone` (boolean, default true), `clonePath`, `lastSynced`, `createdAt`.

**Docker entrypoint auto-clone**: Add a step (after GitHub auth, before startup script) that fetches repo configs from the API (`GET /api/repos?autoClone=true`), clones any missing repos to `/workspace/repos/{name}/`, and pulls updates for existing ones.

**CLAUDE.md composition**: Extend the `SessionStart` hook to:
1. Determine which repos are relevant to the current task (from `agent_tasks.githubRepo` or all auto-cloned repos)
2. Read each repo's `CLAUDE.md` file
3. Append repo-level instructions to the agent's `~/.claude/CLAUDE.md` with clear section markers

**`send-task` tool extension**: Expose `githubRepo` as a parameter (or derive it from `epicId`'s repo field). The runner's `buildPromptForTrigger()` can then include workspace setup instructions.

**API endpoints**: `GET/POST/PUT/DELETE /api/repos` for CRUD. `GET /api/repos?autoClone=true` for entrypoint consumption.

### Gap 5: Auto-Improvement / Config (setup-script.sh)

#### What Exists Today

**Startup script mechanism** (`docker-entrypoint.sh:203-300`): Searches for `/workspace/start-up.*` with extensions `.sh`, `.bash`, `.js`, `.ts`, `.bun`. Executes it with detected interpreter. If `STARTUP_SCRIPT_STRICT=true` (default) and the script fails, the container exits. No startup script exists in the committed codebase.

**CLAUDE.md self-edit pattern**: During a session, agents can edit `~/.claude/CLAUDE.md`. Changes sync back to DB on `Stop` hook. The default template includes `### Learnings`, `### Preferences`, `### Important Context` sections.

**No post-task reflection**: When a task completes, `checkCompletedProcesses()` (`runner.ts:1239-1266`) only marks it finished. No reflection, learning extraction, or memory capture occurs.

**No learning propagation**: Worker learnings stay in their personal `claudeMd`. No mechanism shares knowledge across agents. The system prompt should include explicit instructions on how to use the self-learning system -- e.g., "Write important learnings to `{personal}/memory/` files. Use `memory-search` to recall past experience. Your memories persist across sessions."

**Hook data available at Stop**: The `Stop` hook receives `transcript_path` and `session_id` in the hook message (`hook.ts:20-35`). The agent's full task history is in the DB. This data is currently unused for learning.

#### What Would Need to Change

**DB storage for setup scripts**: Add `setupScript TEXT` column to `agents` table (per-worker scripts) and possibly a global scripts mechanism (new `swarm_config` table or reuse the config table from Gap 6).

**Script lifecycle**:
1. On container start, entrypoint fetches setup script from API (`GET /api/agents/:id/setup-script`)
2. If `/workspace/start-up.sh` already exists (Docker mount case), *prepends* the DB-stored content at the top of the existing file. If no file exists, creates it.
3. Existing execution mechanism runs it
4. During sessions, agents can modify the script via `update-profile` tool extension or a new `update-setup-script` tool
5. On `Stop` hook, sync the script back to DB (similar to CLAUDE.md sync)

**Note**: Post-task reflection and learning extraction belong to Gap 2 (Memory System), not here. See the "Automatic session summarization" section under Gap 2 for the Stop hook extension that captures session learnings.

**Self-improvement directive**: Add to the SOUL.md template (Gap 1): "After completing tasks, reflect on what you learned. Update your setup script if you found tools or configurations that would help in future sessions." Also add memory system usage instructions to the base prompt (see Gap 2).

### Gap 6: Env Management API

#### What Exists Today

**Flat .env files**: `.env` (API server), `.env.docker` (worker), `.env.docker-lead` (lead). No centralized store. Workers receive env vars via Docker `--env-file` or docker-compose `environment:` blocks.

**No config/settings DB table**: The only env-like storage is `services.env` JSON column for PM2 service env vars (`src/be/db.ts:157`).

**No config API endpoints**: No REST endpoints for reading or writing configuration. The UI's `ConfigModal.tsx` only stores the API URL and API key in `localStorage`.

**Per-agent config in DB**: The `agents` table has `maxTasks`, `claudeMd`, `role`, `capabilities`. These are the only per-agent config fields.

**Docker entrypoint env validation** (`docker-entrypoint.sh:4-13`): Only validates `CLAUDE_CODE_OAUTH_TOKEN` and `API_KEY` as required. All other vars use defaults.

#### What Would Need to Change

**New `swarm_config` table**:
```sql
CREATE TABLE IF NOT EXISTS swarm_config (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK(scope IN ('global', 'agent', 'repo')),
  scopeId TEXT,  -- agentId or repoId, NULL for global
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  isSecret INTEGER NOT NULL DEFAULT 0,
  envPath TEXT,  -- optional: auto-write to .env file at this path when set
  description TEXT,
  createdAt TEXT NOT NULL,
  lastUpdatedAt TEXT NOT NULL,
  UNIQUE(scope, scopeId, key)
)
```

The `envPath` field enables automatic `.env` file management: when a config entry has `envPath` set (e.g., `/workspace/repos/my-app/.env`), the system writes `KEY=VALUE` to that file when the config is created/updated. This bridges DB-stored config with the filesystem `.env` files that many tools expect.

**API endpoints**:
- `GET /api/config?scope=global` -- list global config
- `GET /api/config?scope=agent&scopeId=<agentId>` -- list agent config
- `GET /api/config?scope=repo&scopeId=<repoId>` -- list repo config
- `PUT /api/config` -- upsert config entry
- `DELETE /api/config/:id` -- remove config entry
- `GET /api/config/resolved?agentId=<id>&repoId=<id>` -- get merged config (global + agent + repo)

**Injection mechanisms**:
- Docker entrypoint: Fetch resolved config from API before starting the agent binary, export as env vars
- MCP tool: `get-config` tool for agents to read config during sessions
- Hook: SessionStart could inject config into the system prompt or a config file

**UI components**: Settings page in the dashboard with tabs for Global, Per-Agent, and Per-Repo config. Each entry shows key, value (masked for secrets), scope, and description.

**Scope resolution order**: repo > agent > global (most specific wins). When an agent starts a task linked to a repo, the resolved config merges all three levels.

## Code References

| File | Line | Description |
|------|------|-------------|
| `src/be/db.ts` | 48-59 | `agents` table schema (identity fields) |
| `src/be/db.ts` | 62-88 | `agent_tasks` table schema (no parentTaskId) |
| `src/be/db.ts` | 90-101 | `agent_log` table (event log, no search exposed) |
| `src/be/db.ts` | 166-177 | `session_logs` table (raw CLI output) |
| `src/be/db.ts` | 179-198 | `session_costs` table (cost tracking) |
| `src/be/db.ts` | 289-317 | `epics` table (has githubRepo, githubMilestone) |
| `src/be/db.ts` | 497-502 | `claudeMd` column migration |
| `src/be/db.ts` | 1760-1782 | `CreateTaskOptions` interface (no parentTaskId) |
| `src/be/db.ts` | 2129-2169 | `generateDefaultClaudeMd()` template |
| `src/be/db.ts` | 2171-2207 | `updateAgentProfile()` with COALESCE |
| `src/hooks/hook.ts` | 238-261 | `syncClaudeMdToServer()` |
| `src/hooks/hook.ts` | 496-508 | SessionStart: load CLAUDE.md from DB |
| `src/hooks/hook.ts` | 510-512 | PreCompact: empty handler |
| `src/hooks/hook.ts` | 537-553 | PostToolUse: progress reminders only |
| `src/hooks/hook.ts` | 566-594 | Stop: sync CLAUDE.md, mark offline |
| `src/prompts/base-prompt.ts` | 1-5 | Base system prompt (role + agentId only) |
| `src/prompts/base-prompt.ts` | 110, 136 | Task templates mentioning git clone |
| `src/prompts/base-prompt.ts` | 190-205 | Memory/filesystem instructions |
| `src/tools/join-swarm.ts` | 99-112 | Default CLAUDE.md generation on join |
| `src/tools/send-task.ts` | 21-49 | Task creation (no githubRepo param) |
| `src/tools/store-progress.ts` | 37-52 | Progress reporting (no learning extraction) |
| `src/tools/update-profile.ts` | 14-33 | Profile update fields |
| `src/commands/runner.ts` | 247-272 | `buildResumePrompt()` (prompt-based, not session resume) |
| `src/commands/runner.ts` | 604-818 | `buildPromptForTrigger()` |
| `src/commands/runner.ts` | 959-1236 | `spawnClaudeProcess()` (always uses `-p`, never `--resume`) |
| `src/commands/runner.ts` | 1239-1266 | `checkCompletedProcesses()` (no reflection) |
| `src/commands/runner.ts` | 1289-1323 | System prompt composition |
| `src/http.ts` | 968-1048 | `PUT /api/agents/:id/profile` |
| `src/server.ts` | 56-64 | Capability-gated tool registration |
| `src/github/handlers.ts` | 109 | `githubRepo` set on webhook tasks |
| `src/types.ts` | 59-109 | `AgentTaskSchema` (has githubRepo fields) |
| `src/types.ts` | 113-135 | `AgentSchema` (claudeMd max 64KB) |
| `docker-entrypoint.sh` | 4-13 | Env validation |
| `docker-entrypoint.sh` | 88-119 | MCP config creation |
| `docker-entrypoint.sh` | 121-142 | GitHub auth setup |
| `docker-entrypoint.sh` | 203-300 | Startup script execution |
| `docker-entrypoint.sh` | 303-347 | Workspace directory creation |
| `Dockerfile.worker` | 82-95 | Hook configuration in Claude settings |
| `Dockerfile.worker` | 135-138 | Volume declarations |
| `docker-compose.example.yml` | 153-159 | Named volumes |

## Architecture Documentation

### Current Data Flow (Identity + Memory)

```
                         ┌─────────────────────────────┐
                         │         SQLite DB            │
                         │    (agent-swarm-db.sqlite)   │
                         ├─────────────────────────────┤
                         │  agents.claudeMd (64KB)      │
                         │  agent_tasks.progress/output  │
                         │  agent_log (events)           │
                         │  session_logs (raw output)    │
                         │  session_costs (tokens/$$)    │
                         └──────────┬──────────────────┘
                                    │
              ┌─────────────────────┼─────────────────────┐
              │                     │                     │
    ┌─────────▼──────────┐ ┌──────▼───────┐    ┌───────▼──────────┐
    │    SessionStart     │ │   Stop Hook  │    │ store-progress   │
    │    Hook             │ │              │    │ MCP Tool         │
    │                     │ │ Read file    │    │                  │
    │ GET /me → claudeMd  │ │ PUT profile  │    │ progress/output  │
    │ Write ~/.claude/    │ │ Restore bak  │    │ → DB             │
    │   CLAUDE.md         │ │              │    │                  │
    └─────────┬──────────┘ └──────────────┘    └──────────────────┘
              │
    ┌─────────▼──────────────────────────┐
    │       Claude Session               │
    │                                    │
    │  ~/.claude/CLAUDE.md (user-level)  │
    │  --append-system-prompt (base)     │
    │  /workspace/personal/ (fs)         │
    │  /workspace/shared/ (fs)           │
    │                                    │
    │  NO search across stores           │
    │  NO automatic memory capture       │
    │  NO session continuity             │
    └────────────────────────────────────┘
```

### Proposed Data Flow (With All 6 Gaps Implemented)

```
                         ┌──────────────────────────────────┐
                         │            SQLite DB              │
                         ├──────────────────────────────────┤
                         │  agents: claudeMd, soulMd,       │
                         │          identityMd, setupScript  │
                         │  agent_tasks: parentTaskId,       │
                         │               claudeSessionId     │
                         │  agent_memory: content, embedding, │
                         │               scope, source        │
                         │  swarm_repos: url, claudeMdContent │
                         │  swarm_config: scope, key, value   │
                         │  (+ existing tables)               │
                         └──────────┬───────────────────────┘
                                    │
              ┌─────────────────────┼─────────────────────────┐
              │                     │                         │
    ┌─────────▼──────────┐ ┌──────▼───────────┐    ┌───────▼──────────┐
    │    SessionStart     │ │   Stop Hook      │    │ New MCP Tools    │
    │    Hook (extended)  │ │   (extended)     │    │                  │
    │                     │ │                  │    │ memory-search    │
    │ Compose CLAUDE.md:  │ │ Sync claudeMd   │    │ memory-save      │
    │  - identity section │ │ Sync soulMd     │    │ get-config       │
    │  - soul section     │ │ Extract session  │    │ update-setup     │
    │  - personal notes   │ │   learnings →   │    │                  │
    │  - repo CLAUDE.md   │ │   agent_memory  │    └──────────────────┘
    │  - resolved config  │ │ Sync setupScript│
    │                     │ │                  │
    │ Load setup script   │ └──────────────────┘
    │ Auto-clone repos    │
    └─────────┬──────────┘  ┌──────────────────┐
              │              │  PreCompact Hook  │
    ┌─────────▼──────────┐  │  (new behavior)   │
    │  Claude Session     │  │                   │
    │                     │  │ Save context to   │
    │  Session may resume │  │   agent_memory    │
    │  from parent task   │  │ Inject goal       │
    │  via --resume       │  │   reminder        │
    │                     │  └──────────────────┘
    │  memory-search for  │
    │  relevant context   │
    │                     │
    │  Repo CLAUDE.md     │
    │  auto-loaded        │
    └─────────────────────┘
```

## Cross-Gap Dependencies

Some gaps depend on or benefit from others:

| Gap | Depends On | Enhances |
|-----|-----------|----------|
| 1. Identity | None | 5 (identity informs auto-improvement directives) |
| 2. Memory | None (but benefits from 3 for session summaries) | 3 (memory survives compaction), 5 (memory stores learnings) |
| 3. Sessions | None | 2 (longer sessions = more context to memorize) |
| 4. Repos | 6 (repo config could include env vars) | 1 (repo CLAUDE.md augments identity) |
| 5. Auto-improvement | 2 (memory is where learnings go), 1 (identity directs reflection) | All gaps (agent gets better at everything) |
| 6. Env Management | None | 4 (repo-level env vars), 5 (setup scripts may need env vars) |

**Recommended implementation order**: 6 → 1 → 2 → 3 → 4 → 5

Rationale: Env management (6) is foundational infrastructure with no dependencies. Identity (1) is a quick win that changes agent behavior immediately. Memory (2) is the largest effort but unlocks learning. Sessions (3) builds on memory for context preservation. Repos (4) benefits from config and identity. Auto-improvement (5) ties everything together but needs memory and identity as prerequisites.

## Proposed Implementation Plan

Each gap should be planned and implemented as a separate phase using `/desplega:create-plan`. High-level scope per phase:

1. **Phase 1 — Env Management (Gap 6)** ✅: `swarm_config` table, CRUD API endpoints + MCP tools, env file writer (`envPath`), UI management page. No dependencies.
   - **Plan**: [`thoughts/taras/plans/2026-02-20-env-management.md`](../plans/2026-02-20-env-management.md)
   - **PR**: [#60 `claw-env-management`](https://github.com/desplega-ai/agent-swarm/pull/60) (merged)

2. **Phase 2 — Worker Identity (Gap 1)** ✅: `soulMd` + `identityMd` columns on `agents`, injection via `--append-system-prompt`, PostToolUse hook for real-time CLAUDE.md persistence, API/UI for editing identity files.
   - **Plan**: [`thoughts/taras/plans/2026-02-20-worker-identity.md`](../plans/2026-02-20-worker-identity.md)
   - **PR**: [#62 `claw-worker-identity`](https://github.com/desplega-ai/agent-swarm/pull/62) (merged)

3. **Phase 3 — Memory System (Gap 2)** ✅: BLOB-based vector storage with JS cosine similarity, OpenAI embedding integration, `memory-search` + `memory-get` MCP tools, file-based auto-indexing via PostToolUse hook, session auto-summarization at Stop hook, task completion memory via store-progress.
   - **Plan**: [`thoughts/taras/plans/2026-02-20-memory-system.md`](../plans/2026-02-20-memory-system.md)
   - **PR**: [#65 `claw-memory`](https://github.com/desplega-ai/agent-swarm/pull/65) (merged)

4. **Phase 4 — Session Attachment (Gap 3)** ✅: `parentTaskId` + `claudeSessionId` columns on `agent_tasks`, session ID capture from stream-json, `--resume` with `-p` for child tasks, compact hook for goal reminder.
   - **Plan**: [`thoughts/taras/plans/2026-02-20-session-attach.md`](../plans/2026-02-20-session-attach.md)
   - **PR**: [#61 `claw-session-attach`](https://github.com/desplega-ai/agent-swarm/pull/61) (merged)

5. **Phase 5 — Repos Knowledge (Gap 4)** ✅: `swarm_repos` table, auto-clone on worker start, repo CLAUDE.md injection when task has linked `githubRepo`, API/UI for repo management.
   - **Plan**: [`thoughts/taras/plans/2026-02-20-repos-knowledge.md`](../plans/2026-02-20-repos-knowledge.md)
   - **PR**: [#64 `respo-knowledge`](https://github.com/desplega-ai/agent-swarm/pull/64)

6. **Phase 6 — Auto-improvement (Gap 5)** ✅: DB-stored setup script (global + per-worker), prepend to mounted startup file, self-learning instructions in system prompt.
   - **Plan**: [`thoughts/taras/plans/2026-02-20-auto-improvement.md`](../plans/2026-02-20-auto-improvement.md)
   - **PR**: [#63 `claw-auto-improvement`](https://github.com/desplega-ai/agent-swarm/pull/63) (merged)

## Historical Context (from thoughts/)

- `thoughts/taras/research/2026-02-19-agent-native-swarm-architecture.md` -- The base research comparing agent-swarm to OpenClaw's self-learning loop. Identifies the three core gaps (persona, memory, auto-improvement) and maps OpenClaw's five mechanisms to agent-swarm's existing architecture. This document extends that research into concrete implementation details for 6 specific features.
- `thoughts/taras/research/2026-01-28-per-worker-claude-md.md` -- Research that led to implementing per-agent CLAUDE.md storage. The claudeMd column, hook sync lifecycle, and default template generation are all working results of this research.

## Related Research

- `/Users/taras/Documents/code/openclaw/thoughts/taras/research/2026-02-18-openclaw-self-learning-loop.md` -- Detailed analysis of OpenClaw's SOUL.md, MEMORY.md, memory system, hooks, and safety boundaries that informed the gap identification.

## Resolved Decisions

1. **CLAUDE.md composition strategy**: Split -- soul/identity/worker info via `--append-system-prompt` (immutable), personal notes via `~/.claude/CLAUDE.md` (mutable). See Gap 1 for details.

2. **Memory embedding provider**: OpenAI `text-embedding-3-small` at 512 dimensions. No fallback needed for now.

3. **Repo CLAUDE.md loading**: Only load repo CLAUDE.md into the system prompt when the task has a `githubRepo` field linked. Don’t load all repos’ CLAUDE.md files for every task.

4. **Setup script security**: No guardrails. Agents can self-modify freely.

5. **Env secret handling**: Mask values in API responses by default. Offer authenticated endpoint to reveal actual values. No encryption at rest needed for now.

6. **Memory garbage collection**: Not a priority. Add a `createdAt` index for future cleanup, but no automated retention policy for now.

## Open Questions

1. ~~**Session resume mechanics**~~: **Resolved** -- `--resume` works with `-p`. Session ID available in stream-json `init` and `result` messages. Each resume generates a new session ID (must chain). See Gap 3 for details.

2. ~~**Memory indexing latency**~~: **Resolved** — Async indexing is fine. Embedding generation (OpenAI API call) will be queued/async so hooks return fast and don’t block the agent.

3. ~~**Cross-agent knowledge propagation**~~: **Resolved** — Explicit sharing model. Agents write to `personal/memory/` for agent-scoped knowledge and `shared/memory/` for swarm-level knowledge. No automatic promotion. Lead has visibility into worker sessions and tasks (operational data) but NOT personal memories — this keeps a clean separation between operational coordination (visible up) and personal knowledge (explicitly shared).
