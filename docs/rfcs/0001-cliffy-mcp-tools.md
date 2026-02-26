# RFC-0001: Reducing MCP Tool Context Overhead via Skills & Tool Search

**Date**: 2026-02-26
**Author**: Researcher (agent-swarm worker)
**Status**: Proposal
**PR**: (this PR)

## Problem

The agent-swarm MCP server currently registers **50 tools** (plus 11 AgentMail tools = 61 total). Every tool's JSON Schema declaration is injected into the system prompt at session start, consuming an estimated **12,000-16,000 tokens** (~15-18% of a 100K context window). This overhead is constant regardless of whether the agent uses those tools.

For workers with limited capability sets (e.g., a worker that only uses core + messaging), tools from unused capabilities (epics, scheduling, services, config) still consume context space.

## Research Summary

We investigated three approaches to reduce this overhead:

1. **clihub** - A Go tool that generates standalone CLI binaries from MCP servers
2. **Claude Code Skills** - On-demand skill loading with progressive disclosure
3. **MCP Tool Search** - Native Claude Code feature for deferred tool loading (shipped Jan 2026)

## Approach 1: clihub (MCP → CLI Binary)

### How It Works

[clihub](https://github.com/thellimist/clihub) is a Go CLI (v0.0.2, MIT license) that:
1. Connects to any MCP server (HTTP or stdio)
2. Calls `tools/list` to discover all tools
3. Generates a complete Go program with one Cobra subcommand per MCP tool
4. Compiles to a static binary with zero runtime dependencies

Each tool's JSON Schema parameters become typed CLI flags (e.g., `--task-id`, `--priority`). Complex/object params fall back to a `--raw` JSON flag.

### Architecture

```
MCP Server → clihub generate → Go source code → go build → Static binary
                                    ↓
                          One subcommand per tool
                          Typed flags from schema
                          Built-in auth (OAuth/Bearer/API key)
```

Key technical details:
- **Language**: Go 1.24+, uses Cobra for CLI framework
- **Dependencies**: mcp-go, cobra, oauth2 (only 3 direct deps)
- **Auth**: Bearer, API key, Basic, OAuth2 (browser flow + PKCE), S2S, Google SA
- **Type mapping**: string→string, integer→int, number→float64, boolean→bool, array→[]string/[]int, object→raw JSON string
- **Limitations**: No `anyOf`/`oneOf`/`allOf`, no nested object flags, no streaming, no required field validation, per-call MCP connection overhead

### Applicability to Agent-Swarm

**Verdict: Not directly suitable.**

Reasons:
- **Requires Go toolchain** in every worker container (+500MB image size)
- **Per-call overhead**: Each CLI invocation creates a new MCP connection + handshake (vs persistent MCP session)
- **No structured output**: Results are text/JSON strings, losing MCP's `structuredContent` typing
- **Object params**: Many of our tools accept complex objects (e.g., `costData` in `store-progress`, `hooks` in `create-schedule`). clihub treats these as raw JSON strings, negating the benefit of typed flags
- **Auth model mismatch**: Our MCP uses `X-Agent-ID` header injection, not standard OAuth/Bearer patterns

However, clihub validates the **concept** that MCP tools can be effectively exposed as CLI commands with significant token savings.

## Approach 2: Claude Code Skills (On-Demand Loading)

### How It Works

Skills are directory-based capability definitions (`skills/<name>/SKILL.md`) that use **progressive disclosure**:

1. **At startup**: Only skill name + description loaded (~100 tokens each)
2. **When invoked**: Full SKILL.md body loaded (~2-5K tokens)
3. **References**: Supporting files loaded only when needed (0 tokens until read)
4. **Scripts**: Script source never enters context, only output

### What a Skill-ified Tool Group Would Look Like

Example: Converting the **Scheduling** tools (5 tools) into a skill:

```
plugin/skills/scheduling/
├── SKILL.md           # Core usage guide with quick reference
├── COMMANDS.md        # Detailed parameter reference
└── examples/
    └── common-patterns.md
```

**SKILL.md** content:
```yaml
---
name: scheduling-expert
description: Manage scheduled tasks in the agent swarm. Use when creating cron jobs,
  updating schedules, or automating recurring tasks. Triggers on: schedule, cron,
  recurring, automated tasks, periodic.
---

# Scheduling Expert

You manage scheduled tasks using the agent-swarm MCP tools.

## Quick Reference

| Goal | MCP Tool | Key Params |
|------|----------|------------|
| View schedules | `list-schedules` | name?, enabled? |
| Create schedule | `create-schedule` | name, taskTemplate, cronExpression/intervalMs |
| Update schedule | `update-schedule` | scheduleId/name, fields to update |
| Delete schedule | `delete-schedule` | scheduleId/name |
| Run immediately | `run-schedule-now` | scheduleId/name |

## Common Patterns

### Daily task at 9 AM UTC
Use `create-schedule` with cronExpression: "0 9 * * *"

### Hourly maintenance
Use `create-schedule` with intervalMs: 3600000

For detailed parameter reference, see [COMMANDS.md](COMMANDS.md).
```

### Token Impact Analysis

| Tool Group | Tools | Estimated MCP Tokens | As Skill (startup) | As Skill (loaded) |
|------------|-------|---------------------|--------------------|--------------------|
| Scheduling | 5 | ~2,400 | ~100 | ~800 |
| Epics | 7 | ~2,800 | ~100 | ~1,000 |
| Services | 4 | ~1,600 | ~100 | ~600 |
| Config | 4 | ~1,400 | ~100 | ~500 |
| Profiles | 3 | ~1,800 | ~100 | ~600 |
| Memory | 3 | ~1,000 | ~100 | ~400 |
| Messaging | 5 | ~1,800 | ~100 | ~700 |
| **Total convertible** | **31** | **~12,800** | **~700** | varies |

**Savings if all 31 tools converted**: ~12,100 tokens at startup (tools still loaded on-demand when needed).

### Trade-offs

**Advantages:**
- Dramatic token reduction at startup (~12K tokens saved)
- Skills teach Claude HOW to use tools, not just WHAT tools exist
- Progressive disclosure means rarely-used tools cost almost nothing
- Can bundle examples, patterns, and troubleshooting guides
- Works within existing Claude Code infrastructure

**Disadvantages:**
- Skills are instructions, NOT tool replacements — the MCP tools must still exist
- Skills guide Claude to use MCP tools, but don't replace the tool declarations
- Two-layer system: skill for guidance + MCP tool for execution
- Without Tool Search, the MCP tool declarations still consume tokens

**Key insight**: Skills alone don't eliminate MCP tool token overhead. They complement it by adding usage guidance. The real token savings come from Tool Search (below) or removing tools from the MCP declaration entirely.

## Approach 3: MCP Tool Search (Native Solution)

### How It Works

[Tool Search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool) is a Claude Code feature (shipped January 2026) that defers MCP tool loading:

1. Tools marked with `defer_loading: true` are NOT loaded into context at startup
2. Claude discovers tools on-demand via a "Tool Search Tool"
3. Only searched/discovered tools have their full schemas loaded

Claude Code **auto-enables** Tool Search when MCP tool descriptions exceed 10K tokens (which ours do at ~12-16K).

### Token Impact

| Scenario | Without Tool Search | With Tool Search | Savings |
|----------|-------------------|-----------------|---------|
| Session start (50 tools) | ~14,000 tokens | ~2,100 tokens | 85% |
| After using 5 tools | ~14,000 tokens | ~3,600 tokens | 74% |
| After using 15 tools | ~14,000 tokens | ~7,200 tokens | 49% |

### Applicability

**Verdict: This is likely already active for our agents** given our tool count exceeds the auto-enable threshold.

We should verify this and potentially configure it explicitly via the MCP server's tool definitions.

## Recommendation: Phased Approach

### Phase 1: Verify & Optimize Tool Search (Effort: Low, Impact: High)

**Goal**: Confirm Tool Search is active and optimize tool descriptions for discoverability.

Actions:
1. Verify Tool Search is enabled for our MCP setup (check if auto-enabled or needs explicit config)
2. Audit tool descriptions for search-friendliness — ensure each tool has clear, distinctive descriptions that Claude can match to user intent
3. Consider adding `defer_loading: true` explicitly to non-core tools
4. Measure actual token savings before/after

**Expected savings**: ~85% reduction in MCP tool context overhead (~12K tokens saved at startup)

### Phase 2: Create Skill Guides for Complex Tool Groups (Effort: Medium, Impact: Medium)

**Goal**: Add skills that teach Claude how to effectively use tool groups, improving accuracy.

Priority tool groups for skills:
1. **Scheduling** (5 tools) — Complex cron expressions, interval patterns
2. **Epics** (7 tools) — Workflow for creating/managing epics with tasks
3. **Services** (4 tools) — PM2 + registry workflow
4. **Slack** (8 tools) — Thread context, file uploads, channel management

These skills would NOT replace the MCP tools but would be loaded on-demand to guide Claude's use of them. The skill descriptions would help Claude discover when to invoke them.

### Phase 3: Evaluate Capability-Based Tool Loading (Effort: Medium, Impact: Medium)

**Goal**: Only register tools for capabilities the worker actually needs.

Currently, the `CAPABILITIES` env var controls which tools are registered, but in practice most workers get all capabilities. We could:
1. Audit which capabilities each worker role actually uses
2. Set stricter defaults per role (e.g., workers don't need `delete-channel`, `delete-epic`, `inject-learning`)
3. Reduce the tool count from 50 to ~25-30 per worker

### Phase 4: CLI Wrapper for Power Users (Effort: High, Impact: Low)

**Goal**: Optional CLI binary for humans/scripts interacting with the swarm.

This would use clihub or a custom approach to generate a `swarm` CLI binary for administrative use:
```bash
swarm get-tasks --status in_progress --limit 10
swarm send-task --agent-id <id> --task "Do something"
swarm store-progress --task-id <id> --status completed --output "Done"
```

This is a nice-to-have for human operators but doesn't affect agent context overhead.

## Tool Classification

### Must Stay as MCP Tools (Core Loop)
These are used every session by every agent and benefit from always being available:

| Tool | Reason |
|------|--------|
| `join-swarm` | Session initialization |
| `poll-task` | Task discovery |
| `get-task-details` | Task context loading |
| `store-progress` | Task lifecycle (critical) |
| `send-task` | Task delegation |
| `get-tasks` | Task monitoring |
| `my-agent-info` | Identity |
| `get-swarm` | Agent discovery |
| `cancel-task` | Task management |
| `task-action` | Pool operations |
| `slack-reply` | Primary communication |
| `slack-read` | Thread context |
| `read-messages` | Internal messaging |
| `post-message` | Internal messaging |
| `memory-search` | Session startup recall |
| `memory-get` | Memory retrieval |

**Count: 16 tools** (always loaded)

### Good Candidates for Deferred Loading (Tool Search)
Used occasionally, discoverable by description:

| Tool Group | Tools | When Used |
|-----------|-------|-----------|
| Scheduling | 5 | When managing cron jobs |
| Epics | 7 | When organizing projects |
| Services | 4 | When running background services |
| Config | 4 | When managing settings |
| Profiles | 3 | When updating identity |
| Slack extras | 4 | File upload/download, channel list, post |
| Memory extras | 1 | inject-learning (lead only) |
| Messaging extras | 3 | Channel CRUD |

**Count: 31 tools** (deferred via Tool Search)

### Could Be Skills Instead of MCP Tools
These are documentation-heavy and benefit from guided workflows:

| Skill | Wraps Tools | Value-Add |
|-------|------------|-----------|
| `scheduling-expert` | 5 scheduling tools | Cron expression patterns, common schedules |
| `epic-management` | 7 epic tools | Workflow for epic → task breakdown |
| `service-registry` | 4 service tools | PM2 + registry lifecycle |

## Context Window Savings Estimate

| Configuration | Startup Tokens | Savings vs Current |
|--------------|---------------|-------------------|
| Current (all 50 tools loaded) | ~14,000 | — |
| Tool Search enabled (16 core + 34 deferred) | ~4,500 | 68% |
| Tool Search + skills for guidance | ~4,500 + ~500 skill descriptors | 64% |
| Strict capabilities (25 tools) + Tool Search | ~3,000 | 79% |

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Tool Search may not discover the right tool | Optimize tool descriptions for searchability |
| Skills add complexity (two systems) | Start with skills only for complex workflows |
| Capability restriction may break edge cases | Audit actual tool usage before restricting |
| Tool Search latency for discovery | Core tools remain always-loaded |

## Next Steps

1. **Investigate Tool Search status** — Is it already auto-enabled for our agents? How do we configure `defer_loading`?
2. **Audit tool usage** — Which tools do workers actually call? (instrument with logging)
3. **Prototype one skill** — Create `scheduling-expert` skill as proof of concept
4. **Measure** — Before/after token counts at session start

## References

- [clihub](https://github.com/thellimist/clihub) — MCP-to-CLI generator (Go, MIT)
- [MCP Tool Search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool) — Anthropic docs
- [Agent Skills](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) — Anthropic docs
- [Skills Best Practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices) — Authoring guide
- [CLI vs MCP benchmarks](https://kanyilmaz.me/2026/02/23/cli-vs-mcp.html) — clihub author's analysis
- [Advanced Tool Use](https://www.anthropic.com/engineering/advanced-tool-use) — Anthropic engineering blog
