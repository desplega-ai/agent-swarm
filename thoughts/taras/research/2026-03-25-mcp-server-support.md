---
date: 2026-03-25T18:00:00-04:00
researcher: Claude
git_commit: dfd85d3
branch: main
repository: agent-swarm
topic: "MCP Server Support for Agents — Feasibility and Design Space"
tags: [research, codebase, mcp, skills, providers, docker, configuration]
status: complete
autonomy: critical
last_updated: 2026-03-25
last_updated_by: Claude
---

# Research: MCP Server Support for Agents

**Date**: 2026-03-25
**Researcher**: Claude
**Git Commit**: dfd85d3
**Branch**: main

## Research Question

Feasibility of adding MCP server support to agent-swarm, similar to the existing skill support. Agents would be able to define and set up MCP servers (both per-agent and globally), which get automatically added to `.mcp.json` for the Claude provider and as tools for the pi provider.

## Summary

The existing skills system provides a proven blueprint for MCP server support. Skills follow a well-defined lifecycle: defined as `SKILL.md` files with YAML frontmatter, stored in SQLite with per-agent installation via a junction table, synced to the filesystem at boot (Docker entrypoint) and runtime (runner's `sync-filesystem`), and injected into system prompts. MCP servers could follow the exact same pattern — stored in a `mcp_servers` table, installed per-agent via an `agent_mcp_servers` junction table, and synced to `.mcp.json` (Claude) or injected as `customTools` via `McpHttpClient` (pi-mono) at boot and runtime.

The two providers handle MCP fundamentally differently. Claude discovers MCP servers externally via `.mcp.json` — the adapter already creates per-session copies at `/tmp/mcp-<taskId>.json` with task-specific headers injected. Adding agent-scoped servers would mean merging them into this per-session config. Pi-mono pulls tools programmatically via `McpHttpClient` and injects them as `ToolDefinition[]` callbacks — adding MCP servers would mean connecting to additional MCP endpoints during `createSession()` and merging the resulting tools into the `customTools` array.

Three MCP transport types exist: **stdio** (local subprocess), **Streamable HTTP** (current standard for remote), and **SSE** (deprecated). For Docker containers, Streamable HTTP is the natural fit for remote servers, while stdio works for bundled tools (npx-based servers). The `.mcp.json` schema is simple JSON with transport-specific fields (`command`/`args`/`env` for stdio, `url`/`headers` for HTTP). Security considerations center on secret management (env vars for stdio, headers for HTTP) and scope isolation (agent-scoped vs global servers).

## Detailed Findings

### 1. Skills System — The Existing Blueprint

The skills system provides the architectural template that MCP server support would follow. The full lifecycle:

**Data model** (`src/types.ts:874-925`): Skills have a `SkillSchema` (core definition with type/scope/ownership), an `AgentSkillSchema` (junction table for installation), and `SkillWithInstallInfoSchema` (joined view). Key fields: `type` (remote/personal), `scope` (global/swarm/agent), `ownerAgentId`, source provenance fields for remote skills.

**Storage** (`src/be/db.ts:6996-7393`): Full CRUD via `createSkill()`, `updateSkill()`, `deleteSkill()`, `getSkillById()`, `getSkillByName()`, `listSkills()`, `searchSkills()`. Installation via `installSkill()` (upsert with reactivation), `uninstallSkill()` (hard delete from junction), `getAgentSkills()` (joined query with deduplication — personal skills win over same-named remote skills), `toggleAgentSkill()` (soft toggle).

**HTTP API** (`src/http/skills.ts`): 11 endpoints covering CRUD, install/uninstall, remote fetch from GitHub, remote sync (SHA-256 hash comparison), and filesystem sync.

**MCP tools** (`src/tools/skills/`): 11 agent-facing tools registered unconditionally in `src/server.ts:262-273`. Permission model: workers can create personal skills, only leads can create swarm-scope or install remote skills. Workers can publish personal -> swarm via an approval task flow.

**Injection — three paths**:
1. **System prompt** (`src/prompts/base-prompt.ts:74-77`): Renders `## Installed Skills` section with `- /{name}: {description}` entries from fetched skills data.
2. **Skill fetch** (`src/commands/runner.ts:2069-2093`): Fetches installed skills via `GET /api/agents/${agentId}/skills`, filters active+enabled, builds summary for prompt injection.
3. **Docker entrypoint** (`docker-entrypoint.sh:646-683`): Fetches skills via curl, writes simple skills to filesystem, runs `npx skills add` for complex skills.

### 2. Claude Provider — .mcp.json Management

The Claude provider already has a sophisticated `.mcp.json` management pipeline:

**Static config generation** (`docker-entrypoint.sh:275-295`): The entrypoint builds `/workspace/.mcp.json` from scratch using jq. Currently hardcodes two possible servers: `agent-swarm` (always, using `$MCP_URL`, `$API_KEY`, `$AGENT_ID`) and `agentmail` (conditional on `$AGENTMAIL_API_KEY`).

**Per-session override** (`src/providers/claude-adapter.ts:50-95`): `createSessionMcpConfig()` walks up from `cwd` to find `.mcp.json`, finds the agent-swarm server entry (by name OR by `X-Agent-ID` header presence), injects `X-Source-Task-Id` header, writes to `/tmp/mcp-<taskId>.json`. Passed to Claude CLI via `--mcp-config <path> --strict-mcp-config`.

**Session cleanup** (`src/providers/claude-adapter.ts:238-246`): Deletes `/tmp/mcp-<taskId>.json` after Claude process exits.

**Settings** (`Dockerfile.worker:116-128`): `~/.claude/settings.json` pre-configures `enableAllProjectMcpServers: true` and `enabledMcpjsonServers: ["agent-swarm", "context-mode"]`. New MCP servers would need entries here too.

**Template start-up scripts** (`templates/official/*/start-up.sh`): Currently add the `agentmail` MCP server via jq — demonstrating the pattern of extending `.mcp.json` post-entrypoint.

### 3. Pi Provider — Programmatic Tool Injection

Pi-mono handles MCP tools entirely differently from Claude:

**Tool bridge** (`src/providers/pi-mono-adapter.ts:43-64`): `mcpToolsToDefinitions()` converts MCP tools to pi-mono's `ToolDefinition[]` format. Each tool gets a `name`, `description`, `parameters` (JSON Schema wrapped via `Type.Unsafe()` from TypeBox), and an `execute` callback that proxies to `mcpClient.callTool()`.

**MCP client** (`src/providers/pi-mono-mcp-client.ts:20-124`): A standalone Streamable HTTP client that performs initialize handshake, lists tools, and calls tools via JSON-RPC. Handles both JSON and SSE responses.

**Session creation** (`src/providers/pi-mono-adapter.ts:363-424`): During `createSession()`, instantiates `McpHttpClient`, discovers tools, converts to `ToolDefinition[]`, and passes as `customTools` to `createAgentSession()`.

**Key difference from Claude**: Claude discovers MCP servers externally (reads `.mcp.json`, connects autonomously). Pi-mono receives tools programmatically (agent-swarm connects, converts, injects). Adding new MCP servers for pi-mono means: connect to additional MCP endpoints → list tools → merge into `customTools` array.

### 4. Docker Entrypoint — Bootstrap Sequence

The entrypoint (`docker-entrypoint.sh`) runs 16 phases before `exec`-ing the agent-swarm binary. Relevant phases for MCP support:

- **Phase 7** (lines 166-190): Fetches resolved config from `GET /api/config/resolved?agentId=X&includeSecrets=true`, exports as env vars. MCP server secrets could flow through this same mechanism.
- **Phase 9** (lines 275-295): Generates `/workspace/.mcp.json`. Currently hardcodes two servers. Would need to dynamically add agent-installed MCP servers.
- **Phase 12** (lines 404-470): Fetches and executes startup scripts. Templates already use this to add MCP servers (e.g., agentmail).
- **Phase 15** (lines 646-683): Syncs skills to filesystem. A parallel phase would sync MCP servers to `.mcp.json`.

### 5. Config System — Secrets Management

The config system (`src/http/config.ts`, `src/be/db.ts:4784-4944`) provides scoped key-value storage with secret masking:

- **Scopes**: global, agent, repo — with resolution order: `repo > agent > global` (most-specific wins)
- **Secrets**: `isSecret: true` entries have values masked to `"********"` unless `includeSecrets=true` is passed
- **Env export**: The entrypoint fetches resolved config and exports as env vars, making secrets available to the process

MCP server secrets (API keys, tokens) could be stored as agent-scoped or global secrets in this system, then resolved at boot time for injection into `.mcp.json` entries.

### 6. MCP Transport Types

Three transport types defined in the MCP specification:

**Stdio**: Client spawns server as child process. Communication via stdin/stdout JSON-RPC. Simplest, local-only, one client per server. Works in Docker with `-i` flag. Best for: bundled tools (npx-based servers like GitHub, Slack, Brave Search).

**Streamable HTTP** (current standard, March 2025 spec): Single HTTP endpoint accepting POST (JSON-RPC) and GET (SSE notifications). Sessions via `Mcp-Session-Id` header. Remote-capable, multi-client, scalable. Best for: remote servers in Docker containers.

**SSE** (deprecated): Two separate endpoints for POST and SSE. Replaced by Streamable HTTP. Still supported in Claude Code for backward compatibility.

### 7. .mcp.json Schema

```json
{
  "mcpServers": {
    "<name>": {
      // Stdio
      "type": "stdio",        // optional, inferred from "command"
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "..." }

      // OR HTTP
      "type": "http",         // required
      "url": "https://api.example.com/mcp",
      "headers": { "Authorization": "Bearer ..." }

      // OR SSE (deprecated)
      "type": "sse",          // required
      "url": "https://api.example.com/sse",
      "headers": { ... }
    }
  }
}
```

Supports `${VAR_NAME}` syntax for environment variable expansion. Claude Code CLI provides `claude mcp add-json <name> '<json>'` for programmatic configuration.

### 8. Security Considerations

**Stdio isolation**: Environment variables in `env` are scoped exclusively to that server process. Servers cannot access each other's credentials.

**HTTP auth**: Most servers use Bearer tokens via `headers`. OAuth 2.1 with PKCE is specified but only ~8.5% of servers implement it. Static API keys remain the dominant pattern (53%).

**Agent-scoped vs global**: The config system already supports agent vs global scoping. MCP servers could follow the same model — a globally-defined GitHub MCP server with a shared token, vs an agent-specific server with per-agent credentials.

**Dynamic addition risks**: Adding servers at runtime introduces supply-chain risk. A curated catalog approach (similar to remote skills from trusted GitHub repos) mitigates this.

**Secret storage**: API keys and tokens for MCP servers should be stored as `isSecret: true` entries in the config system, resolved at boot, and injected into `.mcp.json` entries or tool definitions. Never stored in the `mcp_servers` table itself — only references to config keys.

## Code References

| File | Lines | Description |
|------|-------|-------------|
| `src/types.ts` | 874-925 | Skill Zod schemas (blueprint for MCP server schemas) |
| `src/be/migrations/019_skills.sql` | 1-65 | Skills + agent_skills DDL (blueprint for MCP tables) |
| `src/be/db.ts` | 6996-7393 | Skill DB functions (CRUD, install, query) |
| `src/be/skill-parser.ts` | 22-70 | YAML frontmatter parser |
| `src/be/skill-sync.ts` | 28-106 | Filesystem sync (writes SKILL.md files) |
| `src/http/skills.ts` | 1-476 | Skills HTTP API (11 endpoints) |
| `src/tools/skills/` | - | 11 MCP tools for skill management |
| `src/server.ts` | 262-273 | MCP tool registration |
| `src/commands/runner.ts` | 2069-2093 | Skill fetch (agent skills from API, filtering active+enabled) |
| `src/prompts/base-prompt.ts` | 74-77 | System prompt skill section rendering |
| `docker-entrypoint.sh` | 275-295 | .mcp.json generation |
| `docker-entrypoint.sh` | 646-683 | Skill filesystem sync |
| `src/providers/claude-adapter.ts` | 50-95 | Per-session MCP config creation |
| `src/providers/claude-adapter.ts` | 134-163 | Claude CLI args with --mcp-config |
| `src/providers/pi-mono-adapter.ts` | 43-64 | MCP tool-to-ToolDefinition conversion |
| `src/providers/pi-mono-adapter.ts` | 363-424 | Pi-mono session creation with customTools |
| `src/providers/pi-mono-mcp-client.ts` | 20-124 | Standalone MCP HTTP client |
| `src/http/config.ts` | 1-188 | Config CRUD (secrets management) |
| `src/be/db.ts` | 4784-4944 | Config DB functions (scoped resolution) |
| `Dockerfile.worker` | 113-128 | .claude/ settings with MCP permissions |
| `src/commands/shared/client-config.ts` | 4-41 | SERVER_NAME, default configs, hooks |
| `templates/official/coder/start-up.sh` | 10-16 | Template adding agentmail MCP server |

## Architecture Documentation

### Current MCP Touchpoints

The system currently has exactly **two** MCP servers configured for agents:

1. **agent-swarm**: Always present. Provides the swarm's own MCP tools (task management, messaging, skills, etc.). Configured in Docker entrypoint and local setup.
2. **agentmail**: Optional. Added conditionally when `AGENTMAIL_API_KEY` is set. Configured in Docker entrypoint and template start-up scripts.

Both are hardcoded in the entrypoint. There is no dynamic MCP server management.

### Parallel Between Skills and MCP Servers

| Aspect | Skills (existing) | MCP Servers (proposed) |
|--------|-------------------|----------------------|
| **Storage** | `skills` + `agent_skills` tables | `mcp_servers` + `agent_mcp_servers` tables |
| **Types** | remote (GitHub) / personal (agent-created) | remote (registry) / custom (agent-defined) |
| **Scope** | global / swarm / agent | global / swarm / agent |
| **Content** | SKILL.md body | JSON config (type, command/url, env/headers) |
| **Secrets** | N/A (skills don't have secrets) | API keys, tokens stored in config system |
| **Claude injection** | Write to `~/.claude/skills/<name>/SKILL.md` | Merge into `.mcp.json` → `mcpServers.<name>` |
| **Pi injection** | Write to `~/.pi/agent/skills/<name>/SKILL.md` | Connect via McpHttpClient → merge into customTools |
| **Boot sync** | Entrypoint fetches + writes files | Entrypoint fetches + merges into .mcp.json |
| **Runtime sync** | Runner calls `POST /api/skills/sync-filesystem` | Runner calls proposed `POST /api/mcp-servers/sync` |
| **MCP tools** | 11 tools (create, install, publish, etc.) | Similar set (add, install, remove, etc.) |
| **Permissions** | Workers: personal only. Leads: swarm + remote | Same model applies |

### Provider-Specific Injection Paths

**Claude provider**:
1. Entrypoint builds base `.mcp.json` (phase 9)
2. New phase: fetch agent's installed MCP servers from API, merge into `.mcp.json`
3. `createSessionMcpConfig()` already copies and modifies `.mcp.json` per-session — would include agent MCP servers
4. Settings.json needs `enabledMcpjsonServers` entries for new servers OR `enableAllProjectMcpServers: true` (already set)
5. Permission entries in `settings.json` for `mcp__<server-name>__*` patterns

**Pi provider**:
1. `createSession()` already instantiates `McpHttpClient` for the swarm endpoint
2. New: for each installed HTTP MCP server, create additional `McpHttpClient` instances, list tools, merge into `customTools`
3. For stdio MCP servers: would need to spawn the process and create a stdio MCP client (not yet implemented in pi-mono-mcp-client.ts)

### UI Dashboard (new-ui/)

The dashboard already has a skills subsystem that would serve as the blueprint for MCP server views:

- **Skills list page** (`new-ui/src/pages/skills/page.tsx`) — browse all skills
- **Skill detail page** (`new-ui/src/pages/skills/[id]/page.tsx`) — view/edit individual skill
- **Agent detail page** (`new-ui/src/pages/agents/[id]/page.tsx`) — shows agent's installed skills
- **API hooks** (`new-ui/src/api/hooks/use-skills.ts`) — React Query hooks for skill CRUD
- **Type definitions** (`new-ui/src/api/types.ts`) — shared types for skills and MCP

A parallel set of views would be needed for MCP servers: list page, detail/configure page, per-agent installation tab, and corresponding API hooks.

### Data Model Sketch

```sql
CREATE TABLE mcp_servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    type TEXT NOT NULL CHECK(type IN ('remote', 'custom')),
    scope TEXT NOT NULL CHECK(scope IN ('global', 'swarm', 'agent')),
    ownerAgentId TEXT REFERENCES agents(id),
    transport TEXT NOT NULL CHECK(transport IN ('stdio', 'http', 'sse')),
    -- Stdio fields
    command TEXT,
    args TEXT,  -- JSON array
    -- HTTP/SSE fields
    url TEXT,
    headers TEXT,  -- JSON object (non-secret headers only)
    -- Secret references (keys in swarm_config, NOT actual values)
    envConfigKeys TEXT,     -- JSON object: {"ENV_VAR": "config-key-name"}
    headerConfigKeys TEXT,  -- JSON object: {"Header-Name": "config-key-name"}
    -- Provenance (for remote/registry servers)
    sourceUrl TEXT,
    sourceRepo TEXT,
    sourceHash TEXT,
    -- Metadata
    isEnabled INTEGER NOT NULL DEFAULT 1,
    version INTEGER NOT NULL DEFAULT 1,
    createdAt TEXT NOT NULL,
    lastUpdatedAt TEXT NOT NULL,
    UNIQUE(name, scope, COALESCE(ownerAgentId, ''))
);

CREATE TABLE agent_mcp_servers (
    id TEXT PRIMARY KEY,
    agentId TEXT NOT NULL REFERENCES agents(id),
    mcpServerId TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
    isActive INTEGER NOT NULL DEFAULT 1,
    installedAt TEXT NOT NULL,
    UNIQUE(agentId, mcpServerId)
);
```

Key design decisions in this sketch:
- **Secrets are never stored in the table**: `envConfigKeys` and `headerConfigKeys` map env var / header names to keys in the `swarm_config` table. At resolution time, actual values are fetched from config with `includeSecrets=true`.
- **Transport-specific fields**: `command`/`args` for stdio, `url`/`headers` for HTTP/SSE. Validated at the application layer based on `transport` value.
- **Same scope/ownership model as skills**: global, swarm, agent scopes with owner tracking.

## Historical Context (from thoughts/)

- `thoughts/taras/research/2026-03-05-pi-mono-provider-research.md` — Deep dive into pi-mono provider that informed the tool injection analysis
- `thoughts/taras/research/2026-03-08-pi-mono-deep-dive.md` — Further pi-mono architecture analysis
- `thoughts/taras/research/2026-03-18-agent-fs-integration.md` — agent-fs integration pattern (similar external service registration in entrypoint)

## Related Research

- `thoughts/taras/research/2026-03-05-pi-mono-provider-research.md` — Pi-mono provider architecture (also in Historical Context)
- `thoughts/taras/research/2026-03-08-pi-mono-deep-dive.md` — Further pi-mono architecture analysis (also in Historical Context)
- `thoughts/taras/research/2026-03-20-prompt-template-registry.md` — Template/registry patterns

## Open Questions

1. **UI dashboard views**: The `new-ui/` dashboard already has skills pages (`pages/skills/page.tsx`, `pages/skills/[id]/page.tsx`, `api/hooks/use-skills.ts`) that would serve as blueprints. What MCP server UI views are needed — a dedicated list page, per-agent detail tab, install/configure modals?

2. **Runtime sync trigger**: Skills sync via `POST /api/skills/sync-filesystem` called by the runner. What triggers the equivalent MCP server sync? Same runner hook, or a separate mechanism? Does `.mcp.json` get rebuilt mid-session or only between sessions?

3. **Future provider support**: Only `claude` and `pi` providers exist today (`src/providers/index.ts:22`), but the project describes itself as supporting "Claude Code, Codex, Gemini CLI." Should the MCP server data model and injection pipeline be designed to accommodate future providers, or is a provider-specific adapter pattern sufficient?

4. **MCP server health/status**: Should the system track whether installed MCP servers are reachable? Skills don't have a "health" concept, but MCP servers are live services that can go down. Is a health check endpoint needed, or is this out of scope?

5. **OAuth flow for MCP servers**: The research notes ~8.5% of MCP servers use OAuth 2.1. If an agent installs an OAuth-based server, who completes the OAuth flow — the agent operator, the lead, or is this unsupported?

## Design Decisions (Resolved)

Based on review feedback from Taras (2026-03-25):

1. **Stdio in Docker**: Yes, support stdio MCP servers. They work natively with Claude (which spawns them from `.mcp.json`). For pi-mono, stdio servers simply won’t work — show a warning at config time that stdio transport is Claude-only.

2. **Pi-mono transport support**: Pi-mono only supports HTTP MCP servers (via `McpHttpClient`). No need to build a stdio client or use a proxy. This is an accepted limitation — document it clearly.

3. **Settings.json management**: Dynamically expand `settings.json` at boot to include permission entries for installed MCP servers. The goal is to move config ownership to the service (API), not keep it in startup scripts. The entrypoint will fetch the agent’s MCP servers and generate the appropriate `mcp__<name>__*` permission entries.

4. **Template integration**: Deferred. Templates will not define default MCP servers for now. Can be added later by extending `templates/schema.ts`.

5. **Remote registry**: Not needed. MCP servers are defined by their config (command+args or url+headers) and loaded at runtime. No need for a GitHub-based install flow like skills have — the MCP ecosystem already has its own distribution (npm packages, Docker images, HTTP endpoints).

6. **Hot-reload**: Not supported. MCP server changes take effect on the next session. This matches the existing skill behavior and is acceptable.

7. **Cost/resource management**: No artificial limits. Agents can have as many MCP servers as they need. Resource consumption is self-regulating (too many servers = slower startup).

8. **Conflict resolution**: Not our problem. If two MCP servers provide tools with the same name, that’s the agent’s responsibility to manage. Claude already namespaces tools as `mcp__<server>__<tool>`, so true conflicts are unlikely.

## Review Errata

_Reviewed: 2026-03-25 by Claude (automated review, Critical autonomy)_

### Important

- [ ] **Security statistics unsourced** — Section 8 claims "~8.5% of servers implement OAuth 2.1" and "53% static API keys" with no citation. Either add a source or qualify these as estimates.
- [ ] **Future provider extensibility** — The project supports "Claude Code, Codex, Gemini CLI" per CLAUDE.md, but only `claude` and `pi` providers exist (`src/providers/index.ts:22`). The research correctly covers the two existing providers but doesn’t discuss whether the proposed design accommodates future providers without rework. Added to Open Questions.

### Resolved

- [x] **Missing "Open Questions" section** — Added 5 open questions covering UI dashboard, runtime sync, future providers, health checks, and OAuth flows.
- [x] **UI dashboard not investigated** — `new-ui/` has existing skills pages that would blueprint MCP server views. Added "UI Dashboard (new-ui/)" section to Architecture Documentation.
- [x] **Inaccurate runner.ts reference** — `src/commands/runner.ts:1968-2093` was overstated. Lines 1968-2067 are agent profile/template bootstrap, not skills. Skill fetch is only at lines 2069-2093. Description corrected from "skill fetch, prompt injection, filesystem sync" to just "skill fetch." Inline reference in Section 1 also corrected (filesystem sync reference removed; system prompt rendering attributed to `base-prompt.ts:74-77`).
- [x] **"Related Research" duplicated "Historical Context"** — Added cross-references to clarify overlap.
