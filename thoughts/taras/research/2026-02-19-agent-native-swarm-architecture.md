---
date: 2026-02-19T21:30:00Z
researcher: Claude
git_commit: e10703529a2508b9070d7bdfc61db2a2e8e4b241
branch: main
repository: agent-swarm
topic: "Agent-Native Swarm Architecture: Mapping OpenClaw's Self-Learning Loop to Agent-Swarm"
tags: [research, architecture, agent-native, self-learning, memory, persona, openclaw]
status: complete
autonomy: critical
last_updated: 2026-02-19
last_updated_by: Claude
---

# Research: Agent-Native Swarm Architecture

**Date**: 2026-02-19
**Researcher**: Claude
**Git Commit**: e107035
**Branch**: main

## Research Question

How does the current agent-swarm architecture compare to OpenClaw's self-learning loop, and what would it take to implement an agent-native approach? Three specific pain points: (1) worker personas are not meaningfully used -- different names are useless, (2) no unified memory approach, (3) auto-improvement is technically possible but not working properly.

## Summary

Agent-swarm has the *scaffolding* for an agent-native system but lacks the *soul*. The infrastructure is there: per-agent CLAUDE.md with Learnings/Preferences sections, shared filesystem for thoughts, hook-driven lifecycle, and a lead-agent feedback loop. But the pieces don't form a coherent self-learning loop because they're disconnected. Personas are empty labels (name + role stored in DB but never meaningfully injected into behavior). Memory is fragmented across CLAUDE.md, filesystem, task progress, and agent_log -- with no search or retrieval mechanism. Auto-improvement relies entirely on the LLM remembering to write notes to its own CLAUDE.md, with zero automated pipelines.

OpenClaw solves these exact problems with five interconnected mechanisms: (1) SOUL.md as a rich, mutable identity injected every turn, (2) two-tier memory (MEMORY.md always-in-context + memory/*.md semantically searchable), (3) automatic session-to-memory persistence via hooks, (4) hybrid BM25+vector search for recall, and (5) explicit encouragement for the agent to evolve its own identity files. Agent-swarm has none of these -- but its existing architecture (hooks, CLAUDE.md sync, shared volumes, DB-backed state) provides natural integration points to build them.

The gap is not in infrastructure but in *design philosophy*. Agent-swarm treats agents as interchangeable task executors. OpenClaw treats agents as persistent entities with identity, memory, and growth. Bridging this gap requires three changes: making persona meaningful (inject it into every interaction, not just store it), unifying memory (centralize + make searchable), and automating the learning loop (extract lessons from task outcomes without relying on the agent to remember).

## Detailed Findings

### 1. The Persona Problem: Names Without Souls

#### What Agent-Swarm Has

Agent profiles are stored in the `agents` table (`src/be/db.ts:48-59`) with these identity fields:
- `name` -- a string, often auto-generated as `{role}-{agentId.slice(0,8)}` (`src/commands/runner.ts:1367`)
- `description` -- optional free-text
- `role` -- optional, max 100 chars (e.g., "frontend dev")
- `capabilities` -- JSON array of strings
- `claudeMd` -- up to 64KB of personal CLAUDE.md content

On registration via `join-swarm` (`src/tools/join-swarm.ts:99-112`), a default CLAUDE.md is generated (`src/be/db.ts:2129-2169`):
```markdown
# Agent: {name}
{description}
## Role
{role}
## Capabilities
- {cap1}
---
## Notes
If you need to remember something, write it down here.
### Learnings
### Preferences
### Important Context
```

#### How It's (Not) Used

The persona enters the session through two paths:

1. **CLAUDE.md hook** (`src/hooks/hook.ts:496-507`): On `SessionStart`, writes the agent's `claudeMd` to `~/.claude/CLAUDE.md`. Claude Code reads this as user-level instructions. This is the *only* path where persona content reaches the LLM.

2. **Base system prompt** (`src/prompts/base-prompt.ts:1-5`): Only injects the *structural role* (lead/worker) and agent ID -- NOT the agent's name, description, role field, or capabilities:
   ```
   You are part of an agent swarm, your role is: {lead|worker} and your unique identifier is {agentId}.
   ```

3. **Hook output** (`src/hooks/hook.ts:464-491`): Every event outputs `"You are registered as {role} agent \"{name}\""` to stdout. This is a one-line identity reminder, not a rich persona.

**The problem**: The `description`, `role`, and `capabilities` fields in the DB are essentially dead data. They're not injected into the system prompt or CLAUDE.md in any meaningful way. The auto-generated CLAUDE.md includes them as static header text, but there's no instruction telling the agent to *embody* them. Compare with OpenClaw's SOUL.md which explicitly says: *"Embody its persona and tone. Avoid stiff, generic replies."*

Worker names are auto-generated (`worker-a9c7cd8`), never referenced in task prompts, and have no behavioral effect. There is no equivalent of OpenClaw's IDENTITY.md (emoji, creature archetype, visual theme) or SOUL.md (philosophy, boundaries, tone).

#### What OpenClaw Does Differently

| Aspect | Agent-Swarm | OpenClaw |
|--------|-------------|----------|
| Identity definition | DB fields (name, role, description) | SOUL.md (philosophy, tone, boundaries) + IDENTITY.md (name, emoji, archetype) |
| Injection point | CLAUDE.md header (static, template) | Full system prompt section with behavioral instruction |
| Behavioral instruction | None -- just facts about the agent | *"Embody its persona and tone"* |
| Self-modification | Technically possible (update-profile tool) | Explicitly encouraged: *"This file is yours to evolve"* |
| Cross-session evolution | CLAUDE.md syncs back on Stop | SOUL.md persisted to disk, read on next boot |

### 2. The Memory Fragmentation Problem

#### What Agent-Swarm Has (Scattered Across 5 Systems)

**A. CLAUDE.md (`agents.claudeMd` column, `src/be/db.ts:497-501`)**
- 64KB max. Injected via hook on SessionStart, synced back on Stop.
- Has "Learnings", "Preferences", "Important Context" sections.
- **No search capability** -- the entire content is loaded into context every session.
- Equivalent to OpenClaw's MEMORY.md (always in context).

**B. Task progress/output (`agent_tasks.progress`, `agent_tasks.output`, `src/be/db.ts:62-88`)**
- `progress` is a single TEXT field, *overwritten* on each `store-progress` call.
- `output` stores the final task result.
- Accessible via `get-task-details` tool, but only if the agent knows the task ID.
- **No cross-task search** -- agents can't query "what did I learn from similar tasks?"

**C. Agent log (`agent_log` table, `src/be/db.ts:91-101`)**
- Chronological event log: task status changes, progress updates.
- Preserves history that `progress` overwrites.
- **No tool exposes agent_log search to agents** -- it's only queryable via `get-task-details` which returns logs for one specific task.

**D. Filesystem (`/workspace/personal/`, `/workspace/shared/`)**
- Personal volume persists across container restarts.
- Base prompt suggests `memory.txt` or `memory.db` for structured memory (`src/prompts/base-prompt.ts:200-205`).
- Shared thoughts directory: `/workspace/shared/thoughts/{agentId}/research/` and `/plans/`.
- **No indexing, no search** beyond what the agent manually implements with grep/sqlite.

**E. Session logs (`session_logs` table, `src/be/db.ts:167-177`)**
- Raw CLI output captured line-by-line.
- Queryable by taskId or sessionId, but only via internal DB functions -- no MCP tool exposes this.

#### What's Missing vs. OpenClaw

| Feature | OpenClaw | Agent-Swarm |
|---------|----------|-------------|
| Always-in-context memory | MEMORY.md (curated, injected every turn) | CLAUDE.md (injected on session start via hook) |
| Searchable memory | memory/*.md with hybrid BM25+vector search | None -- no search across any memory store |
| Automatic session persistence | Hook writes session summary to memory/*.md on `/new` | None -- no automatic memory capture |
| Semantic recall | `memory_search` tool with embeddings + temporal decay | None |
| Memory indexing | SQLite + sqlite-vec, chunking, multi-provider embeddings | None |
| Cross-session knowledge | memory/*.md accumulate over time, searchable | CLAUDE.md accumulates if agent remembers to write, no search |

**The core gap**: Agent-swarm has *storage* but no *retrieval*. Data accumulates in the DB (task outputs, logs, progress) and filesystem (thoughts, personal workspace) but there's no mechanism for agents to search across their own history. An agent finishing a TypeScript refactoring task has no way to query "how did I handle a similar refactoring last week?" The knowledge is there -- in previous task outputs, in agent_log entries -- but it's locked behind task IDs the agent doesn't know.

### 3. The Auto-Improvement Gap

#### What Agent-Swarm Has

**A. CLAUDE.md self-editing**: Agents *can* edit their own CLAUDE.md during a session (it's at `~/.claude/CLAUDE.md`). Changes sync back to the DB on session Stop (`src/hooks/hook.ts:574-581`). The template includes "Learnings" and "Preferences" sections. But there's no instruction *telling* the agent to update these sections, and no hook that *prompts* the agent to reflect.

**B. Lead-agent feedback loop** (`src/commands/runner.ts:652-782`): When workers complete/fail tasks, the lead receives a `tasks_finished` trigger with output/failure details. The prompt instructs the lead to "Verify output meets requirements" and "Reassign to another worker" on failure. This is coordination, not learning.

**C. `update-profile` MCP tool** (`src/tools/update-profile.ts:26-31`): Agents can programmatically update their `claudeMd` field mid-session. This is the raw mechanism, but no process triggers its use.

**D. Pause/resume** (`src/commands/runner.ts:247-272`): When a task is interrupted and resumed, the previous `progress` text is injected into the resume prompt. This preserves context across crashes but isn't learning.

#### What's NOT There

1. **No post-task reflection hook**: When a task completes or fails, nothing prompts the agent to extract lessons. OpenClaw's session-memory hook automatically captures session summaries. Agent-swarm's Stop hook only syncs CLAUDE.md -- it doesn't generate any new memory content.

2. **No automatic knowledge extraction**: Task outputs and failure reasons are stored in the DB but never processed into reusable knowledge. A failed task's `failureReason` is seen by the lead once, then effectively buried in the database.

3. **No learning propagation**: If worker-1 learns that "the auth service requires a specific header format," that knowledge stays in worker-1's CLAUDE.md. Worker-2 has no way to access it. There's no shared knowledge base.

4. **No feedback on persona effectiveness**: There's no mechanism to evaluate whether an agent's role/capabilities match its actual performance. An agent labeled "frontend dev" that consistently fails frontend tasks won't have its profile updated.

5. **No instruction to self-improve**: Compare:
   - OpenClaw SOUL.md: *"This file is yours to evolve. As you learn who you are, update it."*
   - Agent-swarm CLAUDE.md: *"If you need to remember something, write it down here."*

   OpenClaw actively *encourages* self-modification. Agent-swarm passively *permits* it.

### 4. The Agent Lifecycle (Relevant Architecture for Changes)

#### Current Flow

```
Container start → docker-entrypoint.sh → agent-swarm {role}
  → Runner registers agent (POST /api/agents)
  → Resume paused tasks (if any)
  → Poll loop:
      → GET /api/poll → trigger received
      → buildPromptForTrigger() → slash command prompt
      → spawnClaudeProcess() with --append-system-prompt
      → Claude session:
          → SessionStart hook: load CLAUDE.md from DB
          → Execute task (with slash command as initial prompt)
          → PostToolUse hook: remind about store-progress
          → Stop hook: sync CLAUDE.md back to DB
      → Runner: mark task completed/failed
```

#### Key Hook Points for Agent-Native Integration

The hook system (`src/hooks/hook.ts:150-606`) fires on every Claude Code lifecycle event. Current hooks:

| Event | Current Behavior | Potential Agent-Native Use |
|-------|-----------------|---------------------------|
| `SessionStart` | Load CLAUDE.md from DB | Also inject curated memory context, load persona instructions |
| `UserPromptSubmit` | Check task cancellation | Trigger memory search relevant to the prompt |
| `PreToolUse` | Block if task cancelled | N/A |
| `PostToolUse` | Remind about store-progress | After certain tools, trigger memory update |
| `PreCompact` | (no behavior) | Flush important context to memory before compaction |
| `Stop` | Sync CLAUDE.md, mark offline | **Extract session learnings**, update shared knowledge |

### 5. Communication and Coordination (Context)

The inter-agent communication system includes:
- Internal channels with `general` default channel (`src/be/db.ts:329-354`)
- `post-message` and `read-messages` tools for async messaging
- Lead inbox for Slack message routing
- Epic-based task grouping with progress tracking

This infrastructure is relevant because a unified memory system could leverage channels for knowledge sharing -- e.g., agents posting learnings to a `#knowledge` channel that others can search.

## Architecture Documentation

### Current Architecture (Task-Centric)

```
┌─────────────────────────────────────────────────┐
│                  Agent-Swarm API                 │
│              (src/http.ts, SQLite)               │
├─────────────────────────────────────────────────┤
│  agents  │ agent_tasks │ channels │ agent_log   │
│  (profile│ (progress,  │ (messages│ (events)    │
│   claudeMd)  output)   │          │             │
└───────┬──────────┬──────────┬──────────┬────────┘
        │          │          │          │
   ┌────▼──┐  ┌───▼───┐  ┌──▼───┐  ┌───▼──┐
   │ Lead  │  │Worker1│  │Worker2│  │Slack │
   │(Docker│  │(Docker│  │(Docker│  │(bolt)│
   │ +PM2) │  │ +PM2) │  │ +PM2) │  │      │
   └───────┘  └───────┘  └───────┘  └──────┘

   Each agent session:
   ┌──────────────────────────────┐
   │  Claude CLI Process          │
   │  --append-system-prompt      │
   │  (base-prompt + custom)      │
   │                              │
   │  ~/.claude/CLAUDE.md ←──────── DB sync via hook
   │  /workspace/personal/ ──────── Docker volume
   │  /workspace/shared/   ──────── Shared volume
   │                              │
   │  MCP tools: poll-task,       │
   │  store-progress, send-task,  │
   │  read-messages, etc.         │
   └──────────────────────────────┘
```

### OpenClaw Architecture (Agent-Native)

```
┌──────────────────────────────────────────────────┐
│               OpenClaw Agent Session              │
├──────────────────────────────────────────────────┤
│  System Prompt (rebuilt each session):            │
│  ┌──────────────┐  ┌───────────────┐             │
│  │  SOUL.md      │  │  IDENTITY.md  │             │
│  │  (persona,    │  │  (name, emoji │             │
│  │   tone,       │  │   archetype)  │             │
│  │   philosophy) │  │               │             │
│  └──────────────┘  └───────────────┘             │
│  ┌──────────────┐  ┌───────────────┐             │
│  │  MEMORY.md    │  │  USER.md      │             │
│  │  (curated     │  │  (human       │             │
│  │   long-term)  │  │   preferences)│             │
│  └──────────────┘  └───────────────┘             │
│  ┌──────────────┐  ┌───────────────┐             │
│  │  AGENTS.md    │  │  TOOLS.md     │             │
│  │  (workspace   │  │  (tool notes) │             │
│  │   metadata)   │  │               │             │
│  └──────────────┘  └───────────────┘             │
├──────────────────────────────────────────────────┤
│  Tools:                                          │
│  - memory_search (hybrid BM25+vector)            │
│  - memory_get (snippet reader)                   │
│  - file read/write (can modify SOUL.md)          │
├──────────────────────────────────────────────────┤
│  Hooks:                                          │
│  - session-memory: auto-saves session summary    │
│  - bootstrap: mutates identity on boot           │
│  - compaction: flush context to memory           │
├──────────────────────────────────────────────────┤
│  Memory Store:                                   │
│  ┌──────────────────────────────────┐            │
│  │  ~/.openclaw/memory/{agentId}.sqlite          │
│  │  - Vector embeddings (sqlite-vec)│            │
│  │  - BM25 full-text index          │            │
│  │  - Temporal decay scoring        │            │
│  │  - Hybrid 70/30 vector/text      │            │
│  └──────────────────────────────────┘            │
│  ┌──────────────────────────────────┐            │
│  │  ~/.openclaw/workspace/memory/*.md│            │
│  │  - Auto-generated session files   │            │
│  │  - Manually curated notes         │            │
│  └──────────────────────────────────┘            │
└──────────────────────────────────────────────────┘
```

## Comparative Gap Analysis

### Gap 1: Persona (Agent Identity)

| Dimension | Agent-Swarm (Current) | OpenClaw (Target Pattern) | Gap |
|-----------|----------------------|--------------------------|-----|
| Identity file | CLAUDE.md (generic template) | SOUL.md + IDENTITY.md | No behavioral persona |
| Behavioral instruction | "You are a worker" | "Embody its persona and tone" | No embodiment directive |
| Self-evolution | Permitted (can edit CLAUDE.md) | Encouraged ("this file is yours to evolve") | No encouragement |
| Transparency | N/A | "Tell the user if you change it" | No social contract |
| Cross-agent differentiation | Name + role string | Rich personality + archetype | Agents are interchangeable |

### Gap 2: Memory (Knowledge Persistence)

| Dimension | Agent-Swarm (Current) | OpenClaw (Target Pattern) | Gap |
|-----------|----------------------|--------------------------|-----|
| Always-in-context | CLAUDE.md (up to 64KB) | MEMORY.md (with truncation limits) | Similar mechanism, no curation guidance |
| On-demand recall | None | memory_search (BM25+vector) | **Critical gap** |
| Automatic capture | None | session-memory hook | **Critical gap** |
| Structured storage | agent_log, task outputs (in DB) | memory/*.md (dated markdown) | Data exists but is inaccessible |
| Cross-agent sharing | Shared filesystem (no search) | N/A (single-agent) | Need: searchable shared memory |
| Temporal awareness | None | Temporal decay (30-day half-life) | No recency weighting |

### Gap 3: Auto-Improvement (Learning Loop)

| Dimension | Agent-Swarm (Current) | OpenClaw (Target Pattern) | Gap |
|-----------|----------------------|--------------------------|-----|
| Session persistence | CLAUDE.md sync (manual notes) | Auto session-memory hook | No automation |
| Post-task reflection | None | Implicit via session persistence | **Critical gap** |
| Knowledge extraction | Lead sees task outcomes once | memory_search indexes everything | No extraction pipeline |
| Learning propagation | None (agent-local CLAUDE.md) | N/A (single-agent) | Need: shared learnings |
| Feedback loop | Lead can reassign failed tasks | Agent evolves SOUL.md over time | No behavioral adaptation |

## What Exists That Could Be Leveraged

The agent-swarm architecture already has building blocks that map well to agent-native patterns:

1. **CLAUDE.md hook lifecycle** (`src/hooks/hook.ts`): The SessionStart/Stop sync is already OpenClaw-like. The hook fires on every Claude Code event -- adding a `PreCompact` or `Stop` handler for memory capture is straightforward.

2. **Shared filesystem** (`docker-entrypoint.sh:332-345`): `/workspace/shared/thoughts/` already exists with per-agent directories. This could become the memory file store.

3. **Task output database** (`agent_tasks.output`, `agent_tasks.progress`, `agent_log`): Rich historical data already exists. A post-task hook could extract lessons from this data.

4. **Inter-agent channels** (`channels`, `channel_messages`): Could serve as a knowledge-sharing bus. A `#learnings` channel could accumulate cross-agent knowledge.

5. **Base prompt system** (`src/prompts/base-prompt.ts`): Already templated and role-aware. Injecting persona/memory sections is a matter of extending the template.

6. **MCP tool infrastructure** (`src/tools/`, `src/server.ts`): Adding `memory-search`, `memory-get`, or `reflect` tools follows the existing registration pattern.

7. **DB migration pattern** (`src/be/db.ts:470-640`): Adding new tables (e.g., `agent_memory`) follows the existing try-catch migration approach.

## Code References

| File | Line | Description |
|------|------|-------------|
| `src/be/db.ts` | 48-59 | Agents table schema (identity fields) |
| `src/be/db.ts` | 497-501 | claudeMd column migration |
| `src/be/db.ts` | 2129-2169 | generateDefaultClaudeMd() template |
| `src/be/db.ts` | 2171-2207 | updateAgentProfile() with COALESCE |
| `src/hooks/hook.ts` | 496-507 | SessionStart: load CLAUDE.md from DB |
| `src/hooks/hook.ts` | 566-593 | Stop: sync CLAUDE.md back, mark offline |
| `src/hooks/hook.ts` | 238-261 | syncClaudeMdToServer() |
| `src/prompts/base-prompt.ts` | 1-5 | Base system prompt (role + agentId only) |
| `src/prompts/base-prompt.ts` | 190-205 | Memory filesystem instructions |
| `src/tools/join-swarm.ts` | 99-112 | Default CLAUDE.md generation on join |
| `src/tools/store-progress.ts` | 30-167 | Progress reporting (no learning extraction) |
| `src/tools/update-profile.ts` | 26-31 | claudeMd field in update-profile |
| `src/commands/runner.ts` | 652-693 | tasks_finished trigger prompt for lead |
| `src/commands/runner.ts` | 1289-1323 | System prompt composition |
| `src/commands/runner.ts` | 247-272 | buildResumePrompt with previous progress |
| `docker-entrypoint.sh` | 332-345 | Shared thoughts directory setup |
| `Dockerfile.worker` | 82-95 | Hook configuration in Claude settings |
| `src/types.ts` | 113-135 | AgentSchema (all identity fields) |

## Historical Context (from thoughts/)

- `thoughts/taras/research/2026-01-28-per-worker-claude-md.md` -- The research that led to implementing per-agent CLAUDE.md storage. Covers the DB column, hook sync, default template generation. The implementation is complete and working.
- `thoughts/taras/research/2026-01-22-vercel-cli-integration.md` -- Vercel integration research (not directly related).
- `thoughts/taras/research/2026-01-27-excessive-polling-issue.md` -- Polling fix (related to agent lifecycle).
- `thoughts/taras/research/2026-01-28-sentry-cli-integration.md` -- Sentry CLI in worker image.

## Related Research

- `/Users/taras/Documents/code/openclaw/thoughts/taras/research/2026-02-18-openclaw-self-learning-loop.md` -- The detailed analysis of OpenClaw's self-learning architecture that this research compares against. Covers SOUL.md, MEMORY.md, memory system, hooks, and safety boundaries.

## Open Questions

1. **Memory scope per agent vs. shared**: Should each agent have its own memory index (like OpenClaw's per-agent sqlite), a shared swarm-wide memory, or both? The swarm context is fundamentally multi-agent, unlike OpenClaw's single-agent model.

2. **Embedding provider for vector search**: OpenClaw supports OpenAI, Gemini, Voyage AI, and local models. Which would work best in the Docker worker context? Need to consider latency, cost, and offline capability.

3. **CLAUDE.md size limits**: The 64KB limit may not be enough for a growing MEMORY.md equivalent. Should the memory system be separate from CLAUDE.md, or should CLAUDE.md be split into structured sections with independent storage?

4. **Cross-agent knowledge propagation**: OpenClaw is single-agent, so memory sharing isn't a concern. In a swarm, how should learnings propagate? Options: shared memory table, `#learnings` channel, shared CLAUDE.md section, or a "knowledge curator" agent.

5. **Post-task reflection automation**: Should the system use an LLM call to extract lessons from task outputs (like OpenClaw's session-memory hook calls an LLM for summarization), or use simpler heuristics (e.g., always persist failure reasons, extract TODO items)?

6. **Persona bootstrapping**: How should new agents get meaningful personas? Auto-generated from task history? Copied from a template? Evolved from a generic starting point?

7. **Lead agent as knowledge orchestrator**: Should the lead's responsibility expand beyond task delegation to include knowledge curation -- reviewing learnings from workers and propagating them to the swarm?
