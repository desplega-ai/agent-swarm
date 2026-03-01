---
date: 2026-02-26T20:10:00Z
researcher: Researcher
repository: desplega-ai/agent-swarm
topic: "CLIfying Agent-Swarm and AgentMail MCP Tools — clihub Investigation"
tags: [research, mcp, cli, skills, context-window, tool-search, clihub]
status: complete
autonomy: autopilot
last_updated: 2026-02-26
last_updated_by: Researcher
---

# Research: CLIfying Agent-Swarm and AgentMail MCP Tools

**Date**: 2026-02-26
**Researcher**: Researcher
**Repository**: desplega-ai/agent-swarm

## Research Question

Can we reduce the ~15-18% context window overhead from our 61 MCP tools (50 agent-swarm + 11 AgentMail) by converting them to CLI commands using clihub or Claude Code skills?

## Summary

After thorough investigation of three approaches (clihub CLI generation, Claude Code Skills, and MCP Tool Search), the **most impactful and lowest-effort solution is MCP Tool Search** — a native Claude Code feature shipped in January 2026 that defers tool loading and reduces token overhead by ~85%. clihub is an interesting Go-based code generator but is not directly suitable for our use case due to Go toolchain requirements, per-call connection overhead, and lack of structured output support. Skills complement Tool Search by providing usage guidance but don't replace MCP tool declarations on their own. The recommended approach is a phased strategy: (1) verify/optimize Tool Search, (2) create skill guides for complex tool groups, (3) optimize capability-based tool loading.

## Detailed Findings

### 1. clihub Architecture

**Repository**: https://github.com/thellimist/clihub (Go, MIT, v0.0.2)

clihub is a 4-stage pipeline:

1. **Connect**: Connects to MCP server via HTTP (StreamableHTTP) or stdio transport. Comprehensive auth support (Bearer, API key, OAuth2 with PKCE, Google SA).
2. **Discover**: Calls `tools/list` to enumerate all MCP tools. Supports include/exclude filtering with fuzzy "did you mean?" suggestions.
3. **Generate**: Parses each tool's JSON Schema into Go `ToolOption` structs, maps JSON types to Go types, generates a complete Go program from a ~1190-line template. One Cobra subcommand per tool with typed flags.
4. **Compile**: Runs `go build` with `CGO_ENABLED=0` for static binary. Supports cross-compilation to 6 platforms.

**Code stats**: 4,866 lines production + 3,335 lines tests. Only 3 direct Go dependencies.

**Type mapping**:

| JSON Schema | Go Type | CLI Flag |
|-------------|---------|----------|
| string | string | `--flag-name "value"` |
| integer | int | `--flag-name 42` |
| number | float64 | `--flag-name 3.14` |
| boolean | bool | `--flag-name` |
| array (strings) | []string | `--flag-name a,b,c` |
| object | string (raw JSON) | `--raw '{"key":"val"}'` |

**Key limitation**: `object` parameters fall through to raw JSON strings. This affects our tools like `store-progress` (has `costData` object param), `create-schedule` (complex config), and `update-profile` (multiple text fields). The schema validation story is weak for complex types.

### 2. Agent-Swarm MCP Tools Inventory

**50 tools** registered in `src/server.ts`. 22 always registered, 28 gated by capability flags.

| Category | Count | Always Loaded | Capability Gate |
|----------|-------|---------------|-----------------|
| Core | 9 | Yes | — |
| Config | 4 | Yes | — |
| Slack | 8 | Yes | — |
| AgentMail | 1 | Yes | — |
| Task Pool | 1 | No | `task-pool` |
| Messaging | 5 | No | `messaging` |
| Profiles | 3 | No | `profiles` |
| Services | 4 | No | `services` |
| Scheduling | 5 | No | `scheduling` |
| Epics | 7 | No | `epics` |
| Memory | 3 | No | `memory` |

**Estimated token footprint**: ~12,000-16,000 tokens for all 50 tool declarations (JSON Schema with descriptions, parameter types, validation rules).

### 3. Claude Code Skills System

Skills use **progressive disclosure** for token efficiency:

- **Startup**: Only name + description (~100 tokens per skill)
- **Invocation**: Full SKILL.md body loaded (~2-5K tokens)
- **References**: Supporting files loaded only when needed (0 tokens)
- **Scripts**: Source never enters context, only output

Skills are defined as directories with `SKILL.md` files containing YAML frontmatter + Markdown body. They can be project-level (`.claude/skills/`), user-level (`~/.claude/skills/`), or plugin-level.

**Key insight**: Skills are **instructions**, not tool replacements. They guide Claude on HOW to use tools but don't eliminate the tool declarations from context. To get token savings, skills must be combined with Tool Search or tool removal.

### 4. MCP Tool Search (January 2026)

The most relevant discovery. Tool Search is a native Claude Code feature that:

- Defers loading of tools marked with `defer_loading: true`
- Claude discovers tools on-demand via a special "Tool Search Tool"
- Auto-enabled when MCP tool descriptions exceed 10K tokens (**our case**)
- Measured 85% token reduction in Anthropic's benchmarks

**This may already be active for our agents** given our tool count exceeds the auto-enable threshold.

### 5. Existing Skill Patterns in Our Codebase

We found 10 distinct skill patterns currently deployed:

1. **CLI Expert**: `wts-expert`, `qa-use` — Quick reference tables + workflow guides for CLI tools
2. **SDK Reference**: `agentmail` — API docs with dual-language examples
3. **Agentic Workflow**: `researching`, `planning`, `implementing` — Multi-step processes with autonomy modes
4. **MCP-Wrapping**: `swarm-expert` — References MCP tool names with usage guidance
5. **Thin Redirect**: `process-review` — Points to another skill's section

The `swarm-expert` skill at `plugin/skills/swarm-expert/` already demonstrates the pattern of wrapping MCP tools with a skill guide.

## Code References

| File | Description |
|------|-------------|
| `src/server.ts` | MCP server factory — tool registration with capability gates |
| `src/tools/utils.ts` | `createToolRegistrar()` — auto-extracts X-Agent-ID header |
| `src/tools/*.ts` | Individual tool implementations (50 files) |
| `plugin/skills/` | Skills directory (currently empty except swarm-expert) |

## Architecture Documentation

### Current MCP Tool Loading Flow

```
Agent session starts
  → Claude Code connects to MCP server (stdio/HTTP)
  → MCP server registers ALL tools for agent's capabilities
  → All tool schemas injected into system prompt (~14K tokens)
  → Agent begins work with full tool set always in context
```

### Proposed Flow (with Tool Search + Skills)

```
Agent session starts
  → Claude Code connects to MCP server
  → Core tools loaded immediately (~4.5K tokens)
  → Non-core tools deferred via Tool Search
  → Skill descriptions loaded (~500 tokens for 5 skills)
  → Agent begins work

  When agent needs scheduling:
    → Tool Search discovers scheduling tools
    → Scheduling skill loaded with usage guide
    → Agent uses MCP tools with skill guidance
```

## Open Questions

1. **Is Tool Search already auto-enabled for our agents?** We exceed the 10K token threshold. Need to verify.
2. **Can we configure `defer_loading` per-tool in our MCP server?** The `@modelcontextprotocol/sdk` may support this.
3. **What's the actual tool usage distribution?** Which of the 50 tools do workers actually call? This would inform which to defer.
4. **Does Tool Search work with our custom MCP transport?** Our server uses both stdio and HTTP transports.
5. **AgentMail tools**: The 11 AgentMail tools come from a separate MCP server (`npx agentmail-mcp`). Does Tool Search apply across multiple MCP servers?

## Related Research

- `thoughts/shared/research/2026-02-20-agentmail-mcp-integration.md` — Previous AgentMail MCP research
- `thoughts/shared/research/2026-02-24-context-evals.md` — Context evaluation research
