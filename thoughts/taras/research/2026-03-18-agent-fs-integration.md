---
date: 2026-03-18T14:00:00-05:00
researcher: Claude
git_commit: 05c2b38
branch: main
repository: agent-swarm
topic: "Native integration of agent-fs into agent-swarm"
tags: [research, agent-fs, filesystem, integration, drives, secrets]
status: complete
autonomy: verbose
last_updated: 2026-03-18T15:30:00-05:00
last_updated_by: Claude (final — CLI decision + drive switching)
---

# Research: Native Integration of agent-fs into agent-swarm

**Date**: 2026-03-18
**Researcher**: Claude
**Git Commit**: 05c2b38
**Branch**: main

## Research Question

How to natively integrate agent-fs (at `../agent-fs`) into the swarm so that agents use agent-fs drives instead of the local filesystem for thoughts/docs and documents shared with humans. Specifically: `AGENT_FS_API_URL` controls availability, each agent registers itself with agent-fs, the lead creates a shared drive, and each agent stores its `AGENT_FS_API_KEY` as a swarm secret (scoped to the worker).

## Summary

**agent-fs** is a persistent, searchable filesystem for AI agents providing structured file storage (SQLite metadata + S3 content) with built-in semantic search, versioning, RBAC, and 28 MCP tools. It uses API key auth (`af_` prefix), organizes files into org-scoped drives, and supports collaborative access via member invitations with role-based permissions (viewer/editor/admin).

**agent-swarm** currently uses a two-layer filesystem: Archil FUSE-mounted shared/personal disks in Docker (`/workspace/shared/`, `/workspace/personal/`) and git-tracked `thoughts/` directories in local development. Agents create thoughts (plans, research, brainstorms) under per-agent subdirectories. The swarm has a config system (`swarm_config` table) with global/agent/repo scoping that injects values as environment variables at boot and per-session — this is the natural mechanism for storing and injecting `AGENT_FS_API_KEY` per agent.

The integration surface is well-defined: agent-fs registration happens via `POST /auth/register`, drive management via org/drive REST endpoints, and the swarm's existing config resolution pipeline (`docker-entrypoint.sh` → `fetchResolvedEnv()`) can inject `AGENT_FS_API_URL` and `AGENT_FS_API_KEY` into each worker session. The MCP proxy (`agent-fs mcp`) can be added to `/workspace/.mcp.json` for direct agent access to agent-fs file operations.

## Detailed Findings

### 1. agent-fs API Surface and Architecture

agent-fs is a Bun monorepo with 4 packages:

| Package | Purpose |
|---------|---------|
| `@desplega.ai/agent-fs-core` | Storage engine, DB, search, identity, S3 |
| `@desplega.ai/agent-fs` | CLI binary (`agent-fs`) |
| `@desplega.ai/agent-fs-mcp` | MCP stdio-to-HTTP proxy |
| `@desplega.ai/agent-fs-server` | HTTP server (Hono) |

#### HTTP Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/auth/register` | No | Register user. Body: `{email}`. Returns `{apiKey, userId, orgId}` |
| `GET` | `/auth/me` | Yes | Current user info with defaultOrgId, defaultDriveId |
| `ALL` | `/mcp` | Yes | MCP Streamable HTTP endpoint (JSON-RPC) |
| `GET` | `/orgs` | Yes | List user's orgs |
| `POST` | `/orgs` | Yes | Create org. Body: `{name}` |
| `GET` | `/orgs/:orgId/drives` | Yes | List drives in org |
| `POST` | `/orgs/:orgId/drives` | Yes | Create drive. Body: `{name}` |
| `POST` | `/orgs/:orgId/members/invite` | Yes | Invite user. Body: `{email, role}` |
| `POST` | `/orgs/:orgId/ops` | Yes | Dispatch any file operation. Body: `{op, ...params}` |
| `GET` | `/orgs/:orgId/drives/:driveId/files/*/raw` | Yes | Stream raw file bytes from S3 |

The `/orgs/:orgId/ops` endpoint is the workhorse — accepts `{op: "write", ...params}` and dispatches to the operation registry. An optional `driveId` field in the body overrides the default drive.

Source: `packages/server/src/app.ts`, `packages/server/src/routes/`

#### Authentication Model

- API key format: `af_` prefix + 64 hex chars (32 random bytes)
- Keys stored as SHA-256 hash in `users.api_key_hash` column
- Plaintext returned only once at registration
- Every request except `/health` and `/auth/register` requires `Authorization: Bearer <api-key>`
- Rate limiting: in-memory sliding window, default 60 RPM per key

Source: `packages/core/src/identity/users.ts:12-17`, `packages/server/src/middleware/auth.ts`

#### Drive Concepts

- A **drive** is a namespace/partition within an org — the unit of file storage
- Every org gets a **default drive** (named "default") auto-created at org creation
- Files stored at S3 path: `<orgId>/drives/<driveId>/<file-path>`
- Users can create additional drives via API or CLI
- Drive context resolution: explicit driveId > explicit orgId's default > personal org's default

Source: `packages/core/src/db/schema.ts:44-54`, `packages/core/src/identity/orgs.ts:28`

#### File Operations (26 total)

All dispatched through `POST /orgs/:orgId/ops`:

**Content**: `write`, `cat`, `edit`, `append`, `tail`
**Navigation**: `ls`, `stat`, `tree`, `glob`
**File Management**: `rm`, `mv`, `cp`
**Version Control**: `log`, `diff`, `revert`
**Search**: `grep` (regex via FTS5), `fts` (keyword full-text), `search` (semantic vector)
**Maintenance**: `recent`, `reindex`
**Comments**: `comment-add`, `comment-list`, `comment-get`, `comment-update`, `comment-delete`, `comment-resolve`

Source: `packages/core/src/ops/index.ts`

#### MCP Tools (28 total)

All 26 ops auto-registered as MCP tools from their Zod schemas, plus:
- `health` — check system health (DB, S3, embeddings, version)
- `whoami` — get current user identity, org memberships, drive roles

The MCP server supports both HTTP (stateless, at `/mcp`) and stdio (proxy mode via `agent-fs mcp`).

Source: `packages/mcp/src/tools.ts`, `packages/mcp/src/server.ts:45,76`

#### RBAC

- Org-level membership via `org_members` table with roles: `viewer`, `editor`, `admin`
- Drive-level membership via `drive_members` table with same roles
- Role hierarchy: viewer(0) < editor(1) < admin(2)
- Enforcement at `dispatchOp()` level — every operation checks permission before executing

Source: `packages/core/src/identity/rbac.ts:15-42`

#### Key Environment Variables

**Consumer env vars** (what agent-swarm workers need):

| Env Var | Default | Purpose |
|---------|---------|---------|
| `AGENT_FS_API_URL` | (none) | Remote server URL for CLI/MCP proxy |
| `AGENT_FS_API_KEY` | (none) | API key for CLI/MCP proxy |

**Server-side env vars** (only for agent-fs API deployment, not for consumers):

| Env Var | Default | Purpose |
|---------|---------|---------|
| `S3_ENDPOINT` / `AWS_ENDPOINT_URL_S3` | `http://localhost:9000` | S3 endpoint |
| `S3_BUCKET` / `BUCKET_NAME` | `agentfs` | S3 bucket name |
| `SERVER_PORT` | `7433` | HTTP server port |
| `EMBEDDING_PROVIDER` | `local` | `local`, `openai`, or `gemini` |

### 2. agent-swarm Boot Flow and Agent Lifecycle

#### Docker Entrypoint Sequence (`docker-entrypoint.sh`)

1. **Auth validation** (lines 5-24): Checks provider credentials
2. **Archil FUSE mounts** (lines 26-57): Mounts shared/personal disks at `/workspace/shared/` and `/workspace/personal/`
3. **PM2 initialization** (lines 93-134): Starts PM2, fetches ecosystem config
4. **Swarm config fetch** (lines 150-173): `GET /api/config/resolved?agentId={id}&includeSecrets=true` → exports as env vars
5. **MCP config creation** (lines 176-196): Writes `/workspace/.mcp.json` with agent-swarm MCP server
6. **GitHub/GitLab auth** (lines 198-246)
7. **Repo auto-clone** (lines 248-290)
8. **Setup script fetch and compose** (lines 305-371)
9. **Startup script execution** (lines 375-466)
10. **Per-agent shared dirs** (lines 489-543): Creates `thoughts/{agentId}/`, `memory/{agentId}/`, etc. with Archil checkout
11. **Drop to worker user** (line 549): `exec gosu worker /usr/local/bin/agent-swarm "$ROLE" "$@"`

#### CLI Runner (`src/commands/runner.ts`)

1. Creates provider adapter (claude or pi)
2. Registers agent via `POST /api/agents`
3. Fetches full profile via `GET /me`
4. Generates/applies templates for missing profile fields
5. Writes workspace files (SOUL.md, IDENTITY.md, TOOLS.md, CLAUDE.md, start-up.sh)
6. Resumes paused tasks
7. Enters main polling loop

#### Per-Session Config Refresh

`fetchResolvedEnv()` (runner.ts:170-207) is called before every task:
1. Copies `process.env` (includes entrypoint-injected vars)
2. Fetches `GET /api/config/resolved?agentId=...&includeSecrets=true`
3. Overlays config entries onto env
4. Resolves credential pools (comma-separated values)
5. Passes resulting env to `Bun.spawn()` for the Claude process

### 3. Secrets/Config System

#### Storage: `swarm_config` Table

```sql
CREATE TABLE swarm_config (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL CHECK(scope IN ('global', 'agent', 'repo')),
    scopeId TEXT,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    isSecret INTEGER NOT NULL DEFAULT 0,
    envPath TEXT,
    description TEXT,
    createdAt TEXT NOT NULL,
    lastUpdatedAt TEXT NOT NULL,
    UNIQUE(scope, scopeId, key)
);
```

Source: `src/be/migrations/001_initial.sql:246-258`

#### Scoping and Resolution

| Scope | scopeId | Purpose |
|-------|---------|---------|
| `global` | `null` | Swarm-wide settings, all agents see them |
| `agent` | agent UUID | Agent-specific overrides |
| `repo` | repo UUID | Repository-specific overrides |

Resolution order: **repo > agent > global** (most-specific wins).

Source: `src/be/db.ts:5031-5057`

#### MCP Tools

| Tool | Description |
|------|-------------|
| `set-config` | Upserts config by (scope, scopeId, key). Supports `isSecret`, `envPath`, `description` |
| `get-config` | Returns resolved config with scope merging |
| `list-config` | Returns raw entries with optional filters |
| `delete-config` | Deletes by config ID |

Source: `src/tools/swarm-config/`

#### Injection Flow

1. **Boot time**: `docker-entrypoint.sh` fetches resolved config and exports as env vars
2. **Per session**: `fetchResolvedEnv()` re-fetches before each task spawn
3. **In Claude process**: Env vars available via `process.env`

No authorization enforcement on config tools — any agent can set/read/delete at any scope.

### 4. Current Filesystem Usage for Thoughts/Docs

#### Two Distinct Systems

**A. Docker containers** (`/workspace/shared/thoughts/{agentId}/`):
- Created at boot by `docker-entrypoint.sh` (lines 536-538)
- Structure: `plans/`, `research/`, `brainstorms/`
- Write isolation via Archil FUSE checkout per agent
- Shared across agents via Archil shared disk

**B. Local development** (`thoughts/{username}/` at repo root):
- Git-tracked, convention-based (not enforced by tooling)
- Structure: `thoughts/taras/research/`, `thoughts/shared/`, etc.
- 80+ existing files across multiple agents and users

Source: `src/prompts/base-prompt.ts:228-304` (`BASE_PROMPT_FILESYSTEM`)

#### Template-Specific Filesystem References

| Template | Filesystem References |
|----------|----------------------|
| researcher | Store findings in `/workspace/shared/thoughts/<your-id>/research/` |
| tester | Write learnings to `/workspace/shared/memory/<your-id>/` |
| content-writer | Use `/workspace/shared/content-prompts/` and scripts |
| content-strategist | Use `/workspace/shared/content-data/` and scripts |

Source: `templates/official/*/CLAUDE.md`

#### Document Sharing with Humans

Current channels:
1. **Slack**: `slack-reply`, `slack-upload-file` (upload from `/workspace/`)
2. **Artifacts**: HTML served via localtunnel at `https://{agentId}-{name}.lt.desplega.ai`
3. **Shared filesystem**: `thoughts/` discoverable via `ls /workspace/shared/thoughts/*/plans/`
4. **Dashboard UI**: Task outputs visible in `new-ui/`
5. **Git PRs**: Implementation results as pull requests

#### store-progress Tool

Writes to **database only**, not filesystem:
- Updates task progress text
- Marks tasks completed/failed
- Creates DB memory records with vector embeddings on completion
- Auto-promotes certain completions to swarm-scope memory

Source: `src/tools/store-progress.ts`

#### Existing agent-fs References

**Zero matches** — no references to "agent-fs", "agent_fs", or "AGENT_FS" anywhere in the agent-swarm codebase. Clean namespace.

## Code References

| File | Line | Description |
|------|------|-------------|
| `docker-entrypoint.sh` | 150-173 | Swarm config fetch + env var export at boot |
| `docker-entrypoint.sh` | 176-196 | MCP config (`/workspace/.mcp.json`) creation |
| `docker-entrypoint.sh` | 489-543 | Per-agent shared directory setup |
| `src/commands/runner.ts` | 170-207 | `fetchResolvedEnv()` — per-session config refresh |
| `src/commands/runner.ts` | 1129 | `spawnProviderProcess()` — session spawn with env |
| `src/commands/runner.ts` | 1638 | Agent registration via `POST /api/agents` |
| `src/be/db.ts` | 4849 | `maskSecrets()` — secret value masking |
| `src/be/db.ts` | 5031-5057 | `getResolvedConfig()` — scope-merged resolution |
| `src/be/migrations/001_initial.sql` | 246-258 | `swarm_config` table schema |
| `src/tools/swarm-config/` | * | set/get/list/delete-config MCP tools |
| `src/prompts/base-prompt.ts` | 228-304 | `BASE_PROMPT_FILESYSTEM` — filesystem instructions |
| `src/hooks/hook.ts` | 689-698 | SessionStart — writes CLAUDE.md |
| `src/providers/claude-adapter.ts` | 64-69 | Env injection into spawned Claude process |
| `../agent-fs/packages/server/src/app.ts` | 69-74 | Route mounting |
| `../agent-fs/packages/server/src/routes/auth.ts` | 9-37 | Registration endpoint |
| `../agent-fs/packages/server/src/routes/ops.ts` | 9-40 | File operations dispatch |
| `../agent-fs/packages/core/src/identity/rbac.ts` | 15-42 | RBAC enforcement |
| `../agent-fs/packages/core/src/identity/orgs.ts` | 28 | Default drive auto-creation |
| `../agent-fs/packages/core/src/db/schema.ts` | 44-54 | Drive table schema |

## Architecture Documentation

### Integration Surface Map

```
                    agent-swarm API
                         │
                    ┌────┴────┐
                    │ swarm_  │
                    │ config  │ (stores AGENT_FS_API_URL globally,
                    │ table   │  AGENT_FS_API_KEY per agent)
                    └────┬────┘
                         │
         ┌───────────────┼───────────────┐
         │               │               │
    docker-entrypoint  runner.ts     hook.ts
    (boot: export     (per-session:  (SessionStart:
     env vars)        fetchResolved   could write
                      Env → spawn)    .mcp.json)
         │               │
         └───────┬───────┘
                 │
          Claude Code process
          (has AGENT_FS_API_URL +
           AGENT_FS_API_KEY as env vars)
                 │
          ┌──────┴──────┐
          │             │
     .mcp.json      env vars
     (agent-fs       (for any
      MCP server)     SDK/CLI use)
          │
    agent-fs MCP proxy
    (stdio→HTTP, uses
     AGENT_FS_API_URL +
     AGENT_FS_API_KEY)
          │
    agent-fs HTTP server
    (/auth/register,
     /orgs/:orgId/ops,
     /mcp)
```

### MCP vs CLI: Pros and Cons

agent-fs exposes the same 28 operations via both MCP tools and CLI commands. The question is which interface the Claude Code process should use.

#### Option A: MCP (via `.mcp.json` → agent-fs MCP proxy)

| Pros | Cons |
|------|------|
| 28 tools auto-discovered by Claude — no prompt instructions needed | **Tool bloat**: 28 agent-fs + ~30 agent-swarm tools = ~58 total tools per session |
| Structured JSON input/output, native to Claude’s tool system | Adds to `.mcp.json` complexity |
| Tool schemas provide auto-validation | MCP proxy is an extra stdio→HTTP hop |
| Richer error handling (MCP error protocol) | Potential tool namespace conflicts with agent-swarm tools |
| Works with any provider (claude, pi-mono) natively | Requires `agent-fs` binary installed in the container |
| | **Cannot switch drives per-request** — MCP always uses personal org’s default drive (see Drive Switching below) |

#### Option B: CLI (via `agent-fs <command>` in Bash tool)

| Pros | Cons |
|------|------|
| Simpler setup — just env vars, no MCP server | Agents need to learn CLI commands (skill needed) |
| No extra process to manage | Shell parsing overhead, less structured errors |
| Works without MCP proxy infrastructure | No auto-discovery — agents need prompt instructions |
| Pipe-friendly (stdin for content) | JSON output parsing adds friction |
| Auto-detects daemon vs embedded mode | Less natural for multi-step file workflows |

#### Decision: CLI approach

**CLI is the chosen interface** for agent-fs integration, for these reasons:
1. **No tool bloat** — avoids adding 28 MCP tools to the already ~30 agent-swarm tools per session
2. **Drive switching works** — `--org <orgId>` per-command and `drive switch` for persistent context
3. **Skill injection** — the agent-fs Claude Code plugin includes a skill (`skills/agent-fs/SKILL.md`) with comprehensive CLI reference that gets injected automatically on relevant tool calls
4. **Simpler infrastructure** — no MCP proxy process, just the `agent-fs` binary in the container + env vars
5. **Admin + ops unified** — same interface for bootstrap commands and file operations

The `agent-fs` binary is installed in the Docker image. `AGENT_FS_API_URL` and `AGENT_FS_API_KEY` env vars are injected via the existing config resolution pipeline. The agent-fs skill teaches agents the CLI commands on-demand.

**Admin commands** (`drive create`, `drive invite`, `auth register`, `onboard`) are CLI-only — not available as MCP tools. Since registration and drive setup happen automatically in the Docker entrypoint, agents never need to call these manually.

### agent-fs Claude Code Plugin

agent-fs ships a **Claude Code plugin** that could be auto-installed in worker containers:

- **Plugin manifest**: `.claude-plugin/plugin.json` — includes an MCP server definition (`agent-fs mcp --embedded`)
- **Skill**: `skills/agent-fs/SKILL.md` — comprehensive CLI reference with command tables, common workflows, and usage patterns

Auto-installing this plugin in the Docker worker would give agents:
1. The agent-fs MCP server auto-configured
2. The `agent-fs` skill loaded on relevant tool calls (file operations, search, etc.)
3. No need for manual `.mcp.json` entries — the plugin handles it

### Drive Switching: Current State

Agents will need two drives: a **personal drive** (default, auto-created at registration) and a **shared drive** (created by the lead). How drive switching works:

| Interface | Can target specific drive? | How |
|-----------|--------------------------|-----|
| **REST API** (`POST /orgs/:orgId/ops`) | **Yes** | Pass `driveId` in request body (`routes/ops.ts:22-24`) |
| **MCP tools** | **No** | Always resolves to personal org's default drive (`mcp/src/server.ts:38`) |
| **CLI `drive switch`** | **Yes, via org** | Persists `defaultOrg` to config; server resolves to that org's default drive. The `defaultDrive` config value is stored but **never sent to the server** — dead code (`cli/src/commands/drive.ts:143-144`) |
| **CLI `--org` flag** | **Yes, per-command** | `agent-fs --org <orgId> write ...` works per-command (`cli/src/index.ts:22,29-49`) |
| **CLI `--drive` flag** | **No** | Declared but never consumed — dead code (`cli/src/index.ts:23`) |

**Default resolution** (`packages/core/src/identity/context.ts`):
1. Explicit `driveId` → use that drive (lines 18-31)
2. Explicit `orgId` only → use org's default drive (`isDefault=true`) (lines 34-51)
3. No org, no drive → user's personal org's default drive (lines 54-85)

**For our integration (CLI approach)**: This works because each org has one default drive:
- Personal org → personal default drive
- Shared org → shared default drive
- Agents can use `--org <sharedOrgId>` per-command for shared writes
- Or `drive switch <sharedDriveId>` to persistently change org context (since `drive switch` resolves the org from the drive ID)

**Key caveat**: If a shared org had multiple drives, the CLI couldn't target a specific non-default drive. For our single-shared-drive model, this is fine.

### Key Patterns

1. **Config injection is already env-var-based**: The `fetchResolvedEnv()` pipeline is the natural place to inject `AGENT_FS_API_URL` and `AGENT_FS_API_KEY`. No new mechanism needed.

2. **MCP server registration is template-based**: The entrypoint writes `.mcp.json` — adding an agent-fs entry there (conditional on `AGENT_FS_API_URL`) would give agents direct MCP access to file operations.

3. **agent-fs registration is stateless**: `POST /auth/register` with an email creates a user, org, and default drive. The API key is returned once. This maps well to storing it as a swarm secret.

4. **Drive sharing uses org membership**: The lead can create a shared org/drive and invite all workers. The `POST /orgs/:orgId/members/invite` endpoint accepts email + role.

5. **Thoughts paths are hardcoded in multiple places**: `base-prompt.ts`, `docker-entrypoint.sh`, and template CLAUDE.md files all reference `/workspace/shared/thoughts/{agentId}/`. Integration would need to update these references or make them conditional.

## Historical Context (from thoughts/)

- `thoughts/taras/research/2026-03-08-drive-loop-concept.md` — Earlier exploration of drive concepts (may relate to agent-fs)
- `thoughts/taras/research/2026-03-11-archil-production-setup.md` — Archil setup details (the current filesystem layer being replaced)
- `thoughts/taras/research/2026-03-11-archil-shared-disk-write-strategies.md` — Write delegation strategies for shared storage
- `thoughts/taras/research/2026-03-10-agent-working-directory.md` — Agent working directory design

## Resolved Design Decisions

1. **Registration orchestration**: Each worker self-registers with agent-fs at boot. The lead is responsible for inviting workers to the shared drive (via `POST /orgs/:orgId/members/invite`). Each worker stores its own `AGENT_FS_API_KEY` as a swarm secret scoped to itself.

2. **Shared drive model**: Single shared org ("swarm" org) with all agents invited as editors. Auto-register and auto-create drives on setup when `AGENT_FS_API_URL` is first configured. The lead creates the shared org/drive and invites workers as they join.

3. **Archil coexistence**: Conditional — agent-fs only activates when `AGENT_FS_API_URL` global env is set (same pattern as Archil with `ARCHIL_MOUNT_TOKEN`). Local filesystem continues to work for repos, artifacts, PM2 state, and any non-thoughts data.

4. **CLI over MCP**: CLI is the chosen interface. Avoids tool bloat (~58 tools), supports drive switching via `--org` flag, and the agent-fs skill provides on-demand CLI knowledge. The `agent-fs` binary is installed in the Docker image. See dedicated analysis above.

5. **Thoughts path migration**: No migration needed. New thoughts go to agent-fs when available; existing local thoughts stay as-is.

6. **Human access**: Via the live dashboard (`live.agent-fs.dev`) connecting with their own credentials. No dashboard UI integration needed initially.

7. **Comment system**: This is the core collaboration mechanism — agents create shared files in agent-fs, humans browse via live dash and leave comments, the swarm checks and addresses them.

8. **Plugin auto-install**: Yes — use `claude plugin add` for the agent-fs plugin in the Docker image. This gives agents both MCP tools and the agent-fs skill automatically.

9. **Bootstrap ordering**: Registration with agent-fs happens in the Docker entrypoint (like Archil mounts), before the agent session starts. The entrypoint calls `agent-fs auth register` or the REST API, stores the API key as a swarm secret, and writes the config.

10. **Lead creates shared drive**: The lead self-registers with agent-fs at first boot, creates the shared org/drive, and invites workers as they join the swarm. Workers only need to self-register — the lead handles shared access.

11. **File location logic**: All thoughts/docs go to agent-fs when available (personal or shared drive via `--org` flag). Since the CLI is the interface, agents use Bash tool with `agent-fs write` — this works regardless of whether the agent is working on a repo or in `/workspace/`. The distinction between repo work and general work is handled by drive context, not by choosing between local FS and agent-fs.

12. **Email identity**: Use `AGENT_EMAIL` env var if set; otherwise default to `{AGENT_ID}@swarm.local`. `AGENT_EMAIL` is more generic and can be reused for other integrations beyond agent-fs.

13. **Shared org ID propagation**: The lead creates the shared org and stores `AGENT_FS_SHARED_ORG_ID` as a global swarm secret (via `set-config`). Workers pick it up automatically through the config resolution pipeline (`fetchResolvedEnv()`). Workers use `agent-fs --org $AGENT_FS_SHARED_ORG_ID write ...` for shared content.

## Open Questions

None — all questions resolved. Ready for planning.

## Review Errata

_Reviewed: 2026-03-18 by Claude (round 1 + round 2)_

### Critical

- [x] **Email-to-identity mapping gap**: agent-fs uses email as the user identifier (`POST /auth/register` requires `{email}`). Agent-swarm agents have UUIDs and names — not emails. Resolved — see Decision #12: use `AGENT_EMAIL` env var if set; otherwise default to `{AGENT_ID}@swarm.local`.

- [x] **orgId/driveId discovery**: Resolved — with CLI approach, agents use `--org <orgId>` per-command for shared writes. The shared org ID is propagated as a global swarm config. Each org has a default drive, so explicit drive ID is not needed. `drive switch` also works for persistent context changes.

### Important

- [x] **Lead's agent-fs identity**: Resolved — lead self-registers at first boot, creates the shared org/drive, and invites workers. Added as Resolved Decision #10.

- [x] **Rate limiting**: Resolved — rate limit is configurable per-server at `server.rateLimit.requestsPerMinute` in `~/.agent-fs/config.json` (default: 60). Change via `agent-fs config set server.rateLimit.requestsPerMinute <N>` or set to 0 to disable. Enforcement is per-API-key (not global). Config location: `packages/core/src/config.ts:72-74`, middleware: `packages/server/src/middleware/rate-limit.ts`.

- [x] **Conditional prompt instructions**: Resolved — sketch added below.

- [x] **Error handling / fallback**: Resolved — when `AGENT_FS_API_URL` is not set, everything works exactly like now (local filesystem). The integration is purely additive. If envs are set but the server is down, the MCP tools/CLI will return errors naturally — no special fallback logic needed.

### Resolved

- [x] `BASE_PROMPT_FILESYSTEM` line range cited as 228-254, actually spans 228-304 — auto-fixed
- [x] Admin commands (register, onboard, drive create/invite) confirmed as CLI-only, not MCP tools — clarified in MCP vs CLI section
- [x] Bootstrap ordering confirmed: happens in Docker entrypoint — added as Resolved Decision #9
- [x] Plugin auto-install confirmed: yes, use `claude plugin add` — added as Resolved Decision #8

### Appendix: Conditional Prompt Instructions Sketch

When `AGENT_FS_API_URL` is set, `BASE_PROMPT_FILESYSTEM` should include an agent-fs section like:

```
## Agent Filesystem (agent-fs)

You have access to agent-fs — a persistent, searchable filesystem shared across the swarm.
Use the `agent-fs` CLI for all thoughts, research, plans, and shared documents.

The agent-fs Claude Code plugin provides a skill with full CLI reference — it auto-injects
on relevant tool calls. You can also run `agent-fs docs` for interactive CLI documentation.

### Writing to your personal drive (default)
agent-fs write thoughts/research/YYYY-MM-DD-topic.md --content "..." -m "description"
echo "content" | agent-fs write thoughts/plans/YYYY-MM-DD-topic.md -m "description"

### Writing to the shared drive
agent-fs --org $AGENT_FS_SHARED_ORG_ID write docs/shared-report.md --content "..." -m "for team review"

### Reading and searching
agent-fs cat thoughts/research/2026-03-18-topic.md
agent-fs fts "authentication"          # keyword search across all files
agent-fs search "how does auth work"   # semantic search
agent-fs ls thoughts/research/         # list files
agent-fs docs                          # interactive CLI documentation

### Comments (for human-agent collaboration)
agent-fs comment add docs/spec.md --body "Needs clarification on auth flow"
agent-fs comment list docs/spec.md

Key conventions:
- Use the same path structure: thoughts/{agentId}/{type}/YYYY-MM-DD-topic.md
- Add version messages (-m) to writes for auditability
- All CLI output is JSON — parse it
- Use the shared drive (--org) for documents humans or other agents should review
- Run `agent-fs docs` if you need help with any command

Do NOT use the local filesystem (/workspace/shared/thoughts/) for thoughts or shared docs
when agent-fs is available. Local filesystem is still used for: repos, artifacts, scripts,
and any non-thought data.
```

This would be injected conditionally in `getBasePrompt()` (`src/prompts/base-prompt.ts`) when the `AGENT_FS_API_URL` env var is present.

---

## Review Errata (Round 3)

_Reviewed: 2026-03-18 by Claude (structural + content + codebase verification)_

### Important

- [x] **Split-brain search gap**: Decision #11 routes all new thoughts to agent-fs, while Decision #5 says no migration for existing local thoughts (80+ files in `thoughts/`). Accepted as consistent behavior — new content goes to agent-fs, existing local thoughts remain accessible via local FS. No dual-search needed.

- [x] **Concurrent write semantics on shared drive**: Already handled by agent-fs — no concern per author review.

- [x] **Latency impact not characterized**: Acceptable trade-off per author review — HTTP overhead is fine for the use case.

### Resolved

- [x] `spawnProviderProcess()` line reference 1128 → 1129 (was pointing to JSDoc comment, not function declaration) — auto-fixed
- [x] Email-to-identity errata item was still marked unchecked despite being resolved by Decision #12 — auto-fixed
