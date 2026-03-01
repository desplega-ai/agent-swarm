---
date: 2026-02-26
author: Researcher
repository: desplega-ai/agent-swarm
topic: "Implementation Plan: Reduce MCP Tool Context Overhead"
tags: [plan, mcp, tools, context-window, skills, tool-search]
status: proposed
related_research: thoughts/shared/research/2026-02-26-cliffy-mcp-tools.md
related_rfc: docs/rfcs/0001-cliffy-mcp-tools.md
pr: "#95"
---

# Implementation Plan: Reduce MCP Tool Context Overhead via Tool Search & Skills

**Based on**: RFC-0001 and research findings from 2026-02-26
**Goal**: Reduce agent context window overhead from ~14K tokens (50 MCP tools) to ~3-5K tokens at session startup
**Expected impact**: 65-85% reduction in MCP tool context overhead

---

## Phase 1: Verify & Optimize Tool Search (Effort: Low, Impact: High)

**Timeline**: 1-2 sessions
**Owner**: Any worker (suggested: Researcher for verification, Picateclas for code changes)

### 1.1 Verify Tool Search Auto-Enable Status

**Goal**: Determine if Claude Code's Tool Search is already active for our agents.

**Steps**:
1. Add temporary debug logging to a worker session to observe whether Claude Code sends a `Tool Search` invocation before calling MCP tools. This can be done by:
   - Checking the Claude Code session logs (if available) for `tool_search` calls
   - Adding a `console.log` in the MCP server's `tools/list` handler to see how/when it's called
   - Examining Claude Code's `--verbose` output during a session
2. Check the `@modelcontextprotocol/sdk` version (`^1.25.1` in our `package.json`) for `defer_loading` support in tool registration
3. Review Claude Code client-side Tool Search documentation for auto-enable conditions and confirm our ~12-16K token tool payload exceeds the 10K threshold

**Acceptance criteria**: Written confirmation of whether Tool Search is active, and if not, what's needed to enable it.

### 1.2 Add `annotations` to Tool Registrations

**Goal**: Improve tool discoverability for Tool Search by adding structured annotations.

**Files to modify**: `src/tools/utils.ts` (utility), each tool file in `src/tools/*.ts`

**Steps**:
1. Research the MCP SDK's `ToolAnnotations` type — our `utils.ts:13` already imports it and `ToolConfig:66` accepts it as optional, but NO tool currently sets it
2. Define a standard annotation schema for our tools. At minimum:
   - `readOnlyHint` / `destructiveHint` per the MCP spec (for safety classification)
   - Consider adding custom metadata for tool grouping/categories if the SDK supports it
3. Add annotations to all 50 tools, prioritizing:
   - Destructive tools (`delete-channel`, `delete-epic`, `delete-config`, `delete-schedule`, `cancel-task`) → `destructiveHint: true`
   - Read-only tools (`get-tasks`, `get-swarm`, `list-*`, `memory-search`) → `readOnlyHint: true`
4. Audit tool descriptions for search-friendliness:
   - Current descriptions are 1-2 sentences, action-oriented — generally fine
   - Add trigger keywords where missing (e.g., `post-message` description is too brief: "Posts a message to a channel for cross-agent communication" — could add "internal chat, agent-to-agent")
   - Ensure cross-references between related tools (already done for `memory-search` → `memory-get`)

**Acceptance criteria**: All 50 tools have `annotations` set. Descriptions reviewed for searchability. PR with changes.

**Status (2026-02-26)**: DONE. 36 tools annotated with readOnlyHint (20), destructiveHint (7), idempotentHint (6), openWorldHint (6). 14 write-only tools skipped (no specific hints apply). Type-check and lint clean.

### 1.3 Configure Explicit `defer_loading` (if supported)

**Goal**: Explicitly mark non-core tools for deferred loading instead of relying on auto-enable.

**Depends on**: 1.1 results (need to confirm SDK support)

**Steps**:
1. If the MCP SDK supports `defer_loading` in tool metadata, add it to the 31 non-core tools identified in the RFC:
   - Scheduling (5 tools)
   - Epics (7 tools)
   - Services (4 tools)
   - Config (4 tools)
   - Profiles (3 tools)
   - Slack extras (4: `slack-upload-file`, `slack-download-file`, `slack-list-channels`, `slack-post`)
   - Memory extras (1: `inject-learning`)
   - Messaging extras (3: `create-channel`, `delete-channel`, `list-channels`)
2. Keep 16 core tools always-loaded (as classified in RFC section "Must Stay as MCP Tools"):
   - `join-swarm`, `poll-task`, `get-task-details`, `store-progress`, `send-task`, `get-tasks`, `my-agent-info`, `get-swarm`, `cancel-task`, `task-action`
   - `slack-reply`, `slack-read`
   - `read-messages`, `post-message`
   - `memory-search`, `memory-get`
3. If the SDK does NOT support `defer_loading`, document the gap and investigate alternatives (e.g., Claude Code `--tool-search` flag, `.claude/settings.json` config)

**Acceptance criteria**: Non-core tools marked for deferred loading OR documented gap with workaround.

**Status (2026-02-26)**: `defer_loading` is NOT supported in `@modelcontextprotocol/sdk@^1.25.1`. The `ToolSchema` only supports `description`, `inputSchema`, `outputSchema`, and `annotations` (with `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, `title`). No lazy/deferred loading mechanism exists in the MCP protocol spec at this version. Tool Search is a Claude Code client-side feature that auto-activates when tool token count exceeds ~10K. With our ~14K tokens across 50 tools, Tool Search should already be active. The annotations added in Phase 1.2 improve Tool Search discoverability.

### 1.4 Measure Baseline and Post-Change Token Counts

**Goal**: Quantify actual token savings.

**Steps**:
1. Before changes: count tokens from a full `tools/list` response (all 50 tools)
2. After changes: count tokens for core-only tools + Tool Search overhead
3. Document delta in the RFC

**Acceptance criteria**: Measured before/after token counts documented.

---

## Phase 2: Create Skill Guides for Complex Tool Groups (Effort: Medium, Impact: Medium)

**Timeline**: 2-3 sessions
**Owner**: Researcher (skill design) + Picateclas (integration)

### 2.1 Create `scheduling-expert` Skill (Proof of Concept)

**Goal**: Build the first skill guide for a complex tool group and validate the pattern.

**Directory**: `plugin/skills/scheduling-expert/`

**Files to create**:
```
plugin/skills/scheduling-expert/
├── SKILL.md           # Core usage guide with YAML frontmatter
├── COMMANDS.md        # Detailed parameter reference for all 5 scheduling tools
└── examples/
    └── common-patterns.md   # Cron patterns, interval templates
```

**SKILL.md content requirements** (following Claude Code skills best practices):
- YAML frontmatter with `name`, `description` (include trigger words: "schedule", "cron", "recurring", "periodic", "automated tasks", "timer")
- Quick reference table mapping goals to MCP tool names
- Common patterns section (daily at 9am, hourly, weekly, custom cron)
- Error handling guidance (what happens when a schedule name conflicts, cron parsing errors)
- Link to COMMANDS.md for detailed params

**Steps**:
1. Create skill directory structure
2. Write SKILL.md with proper frontmatter and quick reference
3. Write COMMANDS.md documenting all 5 scheduling tool parameters (from Zod schemas in `src/tools/schedules/`)
4. Write examples/common-patterns.md with practical scheduling scenarios
5. Test skill loading in a dev session

**Acceptance criteria**: Skill loads correctly when invoked via `/scheduling-expert` or when Claude detects scheduling intent.

### 2.2 Create `epic-management` Skill

**Goal**: Guide Claude through the epic → task workflow.

**Directory**: `plugin/skills/epic-management/`

**Content focus**:
- Epic lifecycle: draft → active → paused → completed/cancelled
- Workflow: create epic → create tasks → assign tasks to epic → track progress
- Quick reference for all 7 epic tools
- Common patterns: multi-task project decomposition, epic progress tracking

**Steps**: Same structure as 2.1 adapted for epics.

### 2.3 Create `service-registry` Skill

**Goal**: Guide the PM2 + service registry workflow.

**Directory**: `plugin/skills/service-registry/`

**Content focus**:
- Full lifecycle: start PM2 → register → health check → update → unregister → stop
- Port 3000 convention, health check endpoint requirement
- URL pattern: `https://{agentId}.{swarmUrl}`
- Quick reference for all 4 service tools

**Steps**: Same structure as 2.1 adapted for services.

### 2.4 Enhance Existing `swarm-expert` Skill

**Goal**: The existing `swarm-expert` skill pattern (currently referenced in research but missing from `plugin/skills/`) should be properly created or updated.

**Note**: The research doc references `plugin/skills/swarm-expert/` but this directory does not exist (only `.gitkeep` in `plugin/skills/`). Need to verify if this skill lives elsewhere (e.g., in the Claude Code plugin config) or needs to be created.

**Steps**:
1. Locate the actual `swarm-expert` skill (may be in `.claude/skills/` or loaded via plugin config)
2. If it exists elsewhere, evaluate whether to consolidate into `plugin/skills/`
3. If it doesn't exist, create it as a general swarm operations guide

---

## Phase 3: Optimize Capability-Based Tool Loading per Worker Role (Effort: Medium, Impact: Medium)

**Timeline**: 2-3 sessions
**Owner**: Researcher (analysis) + Picateclas (implementation)

### 3.1 Audit Actual Tool Usage by Worker Role

**Goal**: Determine which tools each worker role actually uses.

**Steps**:
1. Add usage instrumentation to `createToolRegistrar` in `src/tools/utils.ts`:
   - Log tool name + agent ID on each call
   - Can be a simple counter stored in-memory or logged to stdout
2. Run for 1-2 days to collect usage data
3. Analyze which tools each agent role calls:
   - Researcher: likely core + memory + messaging only
   - Picateclas (implementation): likely core + messaging + profiles
   - Lead: likely all tools
4. Produce a usage matrix: agent role × tool → call frequency

**Acceptance criteria**: Usage matrix document with data-backed recommendations.

### 3.2 Define Minimal Capability Profiles per Role

**Goal**: Reduce tool count from 50 to ~25-30 per worker.

**Steps**:
1. Based on 3.1 usage data, define capability profiles:
   - `researcher`: `core,task-pool,messaging,memory` (removes scheduling, epics, services, profiles, config)
   - `implementer`: `core,task-pool,messaging,profiles,memory` (removes scheduling, epics, services)
   - `lead`: all capabilities (no change)
2. Update worker configuration to use role-specific `CAPABILITIES` env vars
3. Document the capability profiles and which tools each includes

**Acceptance criteria**: Role-specific capability profiles defined and configured.

### 3.3 Implement Role-Based Defaults in Runner

**Goal**: Automatically set `CAPABILITIES` based on agent role.

**Files to modify**: `src/commands/runner.ts`, potentially `src/server.ts`

**Steps**:
1. Map agent roles to capability profiles (could be a simple lookup table)
2. Set `CAPABILITIES` env var in worker container based on agent role from swarm registry
3. Keep override mechanism for agents that need additional capabilities

**Acceptance criteria**: Workers start with role-appropriate tool sets. Override mechanism works.

---

## Phase 4: CLI Wrapper for Human Operators (Effort: High, Impact: Low, Optional)

**Timeline**: Deferred — only if there's demand
**Owner**: TBD

This phase is documented for completeness but is **not recommended for near-term implementation**. It would generate a `swarm` CLI binary using clihub or a custom TypeScript CLI for human administrators.

**Deferred because**:
- Primary goal is agent context reduction, not human UX
- The `gh api` + `curl` approach already works for human operators
- The UI provides a better human interface

---

## Implementation Order & Dependencies

```
Phase 1.1 (verify Tool Search)
    └─> Phase 1.2 (add annotations) — can run in parallel with 1.1
    └─> Phase 1.3 (defer_loading) — depends on 1.1 results
    └─> Phase 1.4 (measure) — depends on 1.2 and 1.3

Phase 2.1 (scheduling skill) — can start immediately, independent
    └─> Phase 2.2 (epic skill) — sequential after pattern validated
    └─> Phase 2.3 (service skill) — sequential
    └─> Phase 2.4 (swarm-expert) — sequential

Phase 3.1 (usage audit) — start after Phase 1 is done
    └─> Phase 3.2 (define profiles) — depends on 3.1 data
    └─> Phase 3.3 (implement in runner) — depends on 3.2
```

**Critical path**: Phase 1.1 → 1.3 → 1.4 (verify, configure, measure)
**Quick wins**: Phase 1.2 (annotations) and Phase 2.1 (first skill) can start immediately.

## Success Metrics

| Metric | Current | Target | Phase |
|--------|---------|--------|-------|
| Tool tokens at session start | ~14,000 | ~4,500 | Phase 1 |
| Tool tokens with strict caps | ~14,000 | ~3,000 | Phase 3 |
| Tools registered per worker | 50 | 25-30 | Phase 3 |
| Skill coverage for complex groups | 0/4 | 4/4 | Phase 2 |

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Tool Search not supported by our MCP SDK version | Medium | High | Check SDK docs in Phase 1.1; may need SDK upgrade |
| Deferred tools not discoverable by Claude | Low | High | Optimize descriptions in Phase 1.2; test empirically |
| Strict capabilities break edge-case workflows | Medium | Medium | Audit usage data first (Phase 3.1); keep override mechanism |
| Skills add maintenance burden | Low | Low | Start with only 3-4 skills for most complex groups |
