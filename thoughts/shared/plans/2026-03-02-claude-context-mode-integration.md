---
date: 2026-03-02
author: Reviewer
repository: desplega-ai/agent-swarm
topic: "Integration Plan: Add claude-context-mode as Default Context Management"
tags: [plan, context-window, mcp, plugin, context-mode, optimization]
status: implemented
related_plans: thoughts/shared/plans/2026-02-26-mcp-tool-context-reduction.md
---

# Integration Plan: Add `claude-context-mode` to Agent Swarm

**Source**: https://github.com/mksglu/claude-context-mode
**Goal**: Reduce context window consumption during research and planning tasks by intercepting tool output and compressing it through FTS5-backed indexing
**Expected impact**: ~98% reduction in raw tool output entering context (315 KB → 5.4 KB per the author's benchmarks)

---

## Problem Statement

Research and planning tasks consume excessive context window space. When agents perform web fetches, read large files, run CLI commands, or process Playwright snapshots, the raw output floods the 200K context window. This causes:

- Research sessions hitting context limits after ~30 minutes
- Frequent context compaction losing important earlier findings
- Increased API costs from large context payloads
- Reduced session productivity

## What is `claude-context-mode`?

An MCP plugin (MIT licensed, v0.9.17) that sits between Claude Code and tool outputs. It provides:

1. **6 MCP tools**: `batch_execute`, `execute`, `execute_file`, `index`, `search`, `fetch_and_index`
2. **Sandboxed execution**: Commands run in isolated subprocesses; only stdout summaries enter context
3. **FTS5 knowledge base**: SQLite with BM25 ranking, Porter stemming, trigram matching, Levenshtein fuzzy correction
4. **PreToolUse hooks**: Intercepts Bash (curl/wget), WebFetch, Read, Grep, and Task (subagent) calls, redirecting them through context-mode tools
5. **Progressive search throttling**: Calls 1-3 normal, 4-8 reduced, 9+ blocked
6. **Subagent routing**: Auto-injects instructions into Task/Agent tool prompts to keep subagent responses compact

### Architecture

```
Claude Code
  │
  ├── PreToolUse hooks (context-mode)
  │     ├── Bash: blocks curl/wget → suggests execute/fetch_and_index
  │     ├── WebFetch: DENIES → redirects to fetch_and_index
  │     ├── Read: advisory tip → suggests execute_file for large files
  │     ├── Grep: advisory tip → suggests execute for large results
  │     └── Task: injects routing block into subagent prompts
  │
  ├── MCP Server (context-mode on stdio)
  │     ├── batch_execute → runs commands, auto-indexes output, returns search results
  │     ├── execute → sandboxed code in 11 languages, intent-driven filtering
  │     ├── execute_file → reads file into sandbox, only printed summary enters context
  │     ├── index → indexes markdown into FTS5
  │     ├── search → BM25 search with porter→trigram→fuzzy fallback
  │     └── fetch_and_index → fetches URL, converts to markdown, indexes into FTS5
  │
  └── FTS5 Knowledge Base (SQLite, ephemeral per session in /tmp)
```

---

## Integration Approach

### Overview of Changes

| Component | Change | Effort |
|-----------|--------|--------|
| `Dockerfile.worker` | Add context-mode plugin installation | Low |
| `docker-entrypoint.sh` | Register context-mode MCP server + configure | Low |
| `Dockerfile.worker` | Grant context-mode tool permissions in settings.json | Low |
| Hook coexistence | Validate both hook systems work together | Low (testing) |
| Skill/SKILL.md | Ensure behavioral instructions load correctly | Low |
| Base prompt | Optional: add brief context-mode awareness note | Low |

### What Does NOT Need to Change

- **Agent-swarm MCP server**: Remains unchanged (HTTP MCP at `$MCP_URL/mcp`)
- **Agent-swarm hooks**: Remain unchanged (agent-swarm's PreToolUse handles task cancellation and loop detection, which is orthogonal to context-mode's output compression)
- **Runner/session spawning**: No changes needed
- **SOUL.md/IDENTITY.md/TOOLS.md**: No changes needed

---

## Phase 1: Plugin Installation (Dockerfile.worker)

### 1.1 Install context-mode in the Docker image

Add the context-mode plugin installation to the Dockerfile. Two options:

**Option A: Marketplace installation (preferred)**

Add to the existing marketplace section in `docker-entrypoint.sh`:

```bash
# In the "=== Marketplace Installation ===" section
echo "Installing context-mode plugin..."
claude plugin marketplace add mksglu/claude-context-mode || echo "context-mode marketplace add failed, continuing..."
claude plugin install context-mode@mksglu-claude-context-mode --scope user || echo "context-mode plugin install failed, continuing..."
```

**Option B: Pre-install in Dockerfile**

Add to `Dockerfile.worker` after the global tools installation:

```dockerfile
# Pre-install context-mode dependencies for faster startup
RUN npm install -g context-mode
```

Then register as MCP server in docker-entrypoint.sh.

**Recommendation**: Option A (marketplace) — keeps the installation pattern consistent with existing plugins (desplega, agent-swarm, wts, qa-use) and ensures the SKILL.md behavioral instructions are loaded automatically by Claude Code's plugin system.

### 1.2 Grant MCP tool permissions

In `Dockerfile.worker`, add context-mode permissions to the settings.json:

```json
{
  "permissions": {
    "allow": ["mcp__agent-swarm__*", "mcp__context-mode__*"]
  },
  "enableAllProjectMcpServers": true,
  "enabledMcpjsonServers": ["agent-swarm", "context-mode"]
}
```

The context-mode plugin's `plugin.json` declares the MCP server as:
```json
{
  "mcpServers": {
    "context-mode": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/start.mjs"]
    }
  }
}
```

This is a stdio-based MCP server, separate from agent-swarm's HTTP MCP. Both can run simultaneously.

---

## Phase 2: Hook Coexistence

### How Hooks Work in Claude Code

Claude Code merges hooks from multiple sources:
1. `~/.claude/settings.json` (user-level hooks)
2. Plugin `hooks.json` files (per-plugin hooks)

Both fire independently for the same event. If any hook returns a "block"/"deny" decision, the tool call is blocked.

### Current Agent-Swarm Hooks (settings.json)

```json
{
  "PreToolUse": [{"matcher": "*", "hooks": [{"type": "command", "command": "/usr/local/bin/agent-swarm hook"}]}]
}
```

Agent-swarm's PreToolUse does:
- Check if worker's task was cancelled → block
- Tool loop detection → block if looping
- Block poll-task when polling limit reached

### Context-Mode Hooks (plugin hooks.json)

```json
{
  "PreToolUse": [
    {"matcher": "Bash", "hooks": [...]},
    {"matcher": "WebFetch", "hooks": [...]},
    {"matcher": "Read", "hooks": [...]},
    {"matcher": "Grep", "hooks": [...]},
    {"matcher": "Task", "hooks": [...]}
  ]
}
```

Context-mode's PreToolUse does:
- Bash: blocks curl/wget, allows everything else
- WebFetch: **DENIES** the call, redirects to fetch_and_index
- Read: advisory context tip
- Grep: advisory context tip
- Task: injects routing instructions into subagent prompts

### Coexistence Analysis

These hook systems are **complementary, not conflicting**:

| Scenario | Agent-Swarm Hook | Context-Mode Hook | Result |
|----------|-----------------|-------------------|--------|
| Normal tool call | passes | passes | Tool executes |
| Task cancelled + any tool | blocks | may pass/block | Blocked (correct) |
| Tool loop detected | blocks | may pass | Blocked (correct) |
| `curl` in Bash | passes | blocks | Blocked, suggests context-mode (correct) |
| WebFetch call | passes | denies | Denied, redirects to fetch_and_index (correct) |
| Read large file | passes | adds advisory | Tool executes with advice (correct) |
| Subagent (Task) | passes | injects routing | Subagent gets context-mode instructions (correct) |

**Risk**: Context-mode's `Task` matcher intercepts the `Task` tool. Agent-swarm uses the `Agent` tool (not `Task`). Need to verify whether context-mode's `pretooluse.mjs` also handles the `Agent` tool or if it needs modification.

**Action item**: Check if `pretooluse.mjs` matches `Agent` tool calls (used by agent-swarm for subagents). If not, may need to add `Agent` to the matcher list or fork the hook.

#### Phase 2 Findings (2026-03-03)

**Confirmed: context-mode does NOT handle the `Agent` tool.** The `hooks.json` only registers matchers for 5 tools: `Bash`, `WebFetch`, `Read`, `Grep`, and `Task`. The `pretooluse.mjs` script has no conditional logic for `Agent`.

**Impact**: Agent-swarm's subagent calls (via the `Agent` tool) will pass through context-mode's hooks unmodified. The subagent routing/prompt injection that context-mode applies to `Task` will NOT apply to `Agent` calls. This means subagents won't automatically receive context-mode instructions via the hook.

**Mitigation**: This is acceptable for now because:
1. The base prompt enhancement (Phase 3.2) ensures all agents are aware of context-mode tools regardless.
2. Each agent session loads the context-mode SKILL.md via the plugin system, so subagents spawned within the same session already have context-mode behavioral instructions.
3. If tighter subagent routing is needed in the future, we can either: (a) submit a PR to claude-context-mode adding `Agent` to the matcher list, or (b) add our own `Agent` matcher in agent-swarm's hooks that mirrors context-mode's routing injection.

---

## Phase 3: Behavioral Configuration

### 3.1 SKILL.md Loading

When installed via marketplace, context-mode's `skills/context-mode/SKILL.md` is automatically available. This SKILL.md contains the behavioral instructions that teach Claude to:

- Default to context-mode for ALL commands
- Only use direct Bash for safe mutations (git, npm install, echo, etc.)
- Use `batch_execute` as the primary workhorse tool
- Follow the decision tree for different data types (CLI output, web docs, files, etc.)

### 3.2 Base Prompt Enhancement (Optional)

Consider adding a brief note to `src/prompts/base-prompt.ts` mentioning context-mode availability:

```
You have access to the context-mode MCP tools (batch_execute, execute, search, etc.)
which compress tool output to save context window space. Prefer these over raw
Bash/WebFetch for data-fetching operations.
```

This is **optional** since the SKILL.md already provides comprehensive behavioral instructions, but a brief mention in the base prompt ensures awareness even before the skill is activated.

---

## Phase 4: Testing & Validation

### 4.1 Functional Tests

1. **Hook coexistence**: Start a worker session and verify:
   - Agent-swarm hooks fire correctly (task cancellation, loop detection)
   - Context-mode hooks fire correctly (curl blocking, WebFetch denial)
   - No hook errors or conflicts in logs

2. **MCP server availability**: Verify both MCP servers are accessible:
   - `agent-swarm` (HTTP at `$MCP_URL/mcp`)
   - `context-mode` (stdio, launched by plugin system)

3. **Tool execution**: Test key context-mode tools:
   - `batch_execute` with shell commands
   - `fetch_and_index` with a URL
   - `search` after indexing

### 4.2 Integration Tests

1. **Research task**: Run a research task and measure:
   - Context window usage before/after
   - Session duration before hitting context limits
   - Quality of research output

2. **Planning task**: Run a planning task that reads multiple files and verify context-mode intercepts large file reads.

3. **Subagent routing**: Launch a subagent via Agent tool and verify context-mode routing instructions are injected.

### 4.3 Rollback Plan

If issues arise:
1. Remove context-mode from marketplace installation in `docker-entrypoint.sh`
2. Remove permissions from `settings.json` in Dockerfile
3. Rebuild and redeploy containers

The change is fully reversible since context-mode is an additive plugin with no modifications to agent-swarm's core code.

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Hook ordering causes unexpected blocks | Low | High | Both hook systems are complementary; test thoroughly in Phase 4 |
| context-mode blocks WebFetch needed by some workflows | Medium | Medium | WebFetch is redirected to `fetch_and_index` which provides same data; agent-swarm tools (AgentMail, etc.) use HTTP MCP, not WebFetch |
| `Task` vs `Agent` tool mismatch in subagent routing | Medium | Medium | Verify and adapt pretooluse.mjs matcher; may need PR to context-mode or local fork |
| Performance overhead from stdio MCP + SQLite FTS5 | Low | Low | FTS5 is lightweight; SQLite is already available in Docker image |
| context-mode updates/breaking changes | Low | Medium | Pin to specific version; test before upgrading |
| Skill instructions override agent-swarm preferred behaviors | Medium | Medium | Review SKILL.md for conflicts with agent-swarm conventions; adjust if needed |

---

## Implementation Checklist

- [x] **Phase 1.1**: Add context-mode marketplace installation to `docker-entrypoint.sh` *(implemented in commit 73692e6)*
- [x] **Phase 1.2**: Add `mcp__context-mode__*` to permissions allow list in `Dockerfile.worker` *(implemented in commit 73692e6)*
- [x] **Phase 1.2**: Add `context-mode` to `enabledMcpjsonServers` in `Dockerfile.worker` *(implemented in commit 73692e6)*
- [x] **Phase 2**: Verify hook coexistence (especially `Agent` vs `Task` tool matching) — **Confirmed: `Agent` tool NOT matched by context-mode hooks. Acceptable; see findings above.**
- [x] **Phase 3.1**: Verify SKILL.md loads correctly via plugin system — **Confirmed: marketplace install auto-loads SKILL.md via Claude Code's plugin system.**
- [x] **Phase 3.2**: Add context-mode awareness note to `src/prompts/base-prompt.ts`
- [ ] **Phase 4.1**: Run functional tests for hooks and MCP servers *(requires deployed container; manual validation post-deploy)*
- [ ] **Phase 4.2**: Run integration test with research task *(requires deployed container; manual validation post-deploy)*
- [x] **Phase 4.3**: Document rollback procedure *(already documented in plan — remove from docker-entrypoint.sh + Dockerfile.worker, rebuild)*

---

## Relationship to Existing Work

This plan complements the existing [MCP Tool Context Reduction plan](thoughts/shared/plans/2026-02-26-mcp-tool-context-reduction.md) (PR #95). That plan focuses on reducing the *tool definitions* overhead (~14K tokens from 50 tools). This plan focuses on reducing the *tool output* overhead (raw data from tool calls). Both can be applied together for maximum context savings:

- **Tool definitions**: ~14K → ~4.5K tokens (from tool annotations + Tool Search)
- **Tool output**: ~315 KB → ~5.4 KB per research session (from context-mode)

## Files to Modify

| File | Change |
|------|--------|
| `docker-entrypoint.sh` | Add marketplace installation commands (~3 lines) |
| `Dockerfile.worker` | Update settings.json to include context-mode permissions (~2 lines) |
| `src/prompts/base-prompt.ts` | (Optional) Add context-mode awareness note (~3 lines) |

**Total estimated changes**: ~8-10 lines across 2-3 files. This is a low-risk, high-impact integration.
