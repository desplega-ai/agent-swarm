# Research: Improving Agent Self-Improvement in agent-swarm

**Author:** Researcher (worker agent)
**Date:** 2026-02-20
**Status:** Reviewed — Approved proposals: P1, P2, P4, P5, P6, P7. Deferred: P8, Tier 3. See [Implementation Plan](#implementation-plan).
**Repo:** desplega-ai/agent-swarm

---

## Executive Summary

The agent-swarm system already has foundational self-improvement mechanisms: persistent identity files (SOUL.md, IDENTITY.md, CLAUDE.md, TOOLS.md), a vector-searchable memory system, session summarization, and task completion indexing. However, these mechanisms are largely **passive** — they depend on agents voluntarily choosing to write memories, update their identity files, and search past context. This research identifies concrete gaps and proposes improvements that would make the self-improvement loop more **active, structured, and compounding**.

The proposals are organized into three tiers:
- **Tier 1 (High Impact, Low Effort):** Quick wins that plug existing gaps
- **Tier 2 (High Impact, Medium Effort):** Structural improvements to the learning loop
- **Tier 3 (High Impact, High Effort):** Architectural changes for compound intelligence

---

## Current State Analysis

### What Exists Today

| Mechanism | How It Works | Self-Improvement Role |
|-----------|-------------|----------------------|
| **SOUL.md** | Persona/values doc, stored in DB, synced to workspace, injected into system prompt | Agents can edit to refine their behavioral directives |
| **IDENTITY.md** | Expertise/working style, same lifecycle as SOUL.md | Agents can discover and document their strengths |
| **CLAUDE.md** | Personal notes (Learnings, Preferences, Important Context sections), written to `~/.claude/CLAUDE.md` on session start | Agents can accumulate session-persistent notes |
| **TOOLS.md** | Environment-specific knowledge (repos, services, APIs) | Agents can record operational knowledge |
| **start-up.sh** | Setup script with marker-based extraction, runs on container start | Agents can install tools and configure their environment |
| **Memory System** | SQLite-backed vector search (OpenAI text-embedding-3-small, 512d), 4 source types | Searchable long-term storage across sessions |
| **Session Summaries** | Claude Haiku summarizes transcript on session end, indexed into memory | Automatic learning capture from every session |
| **Task Completion Indexing** | Completed task output auto-indexed as agent-scoped memory | Task knowledge persists across sessions |
| **File Auto-Indexing** | Files written to `/workspace/{personal,shared}/memory/` are auto-indexed | Deliberate knowledge can be saved for vector search |
| **Shared Workspace** | `/workspace/shared/` mount + swarm-scoped memories | Cross-agent knowledge sharing |

### What's Missing (Gaps)

#### Gap 1: No Learning from Failures

Task completion indexing (`store-progress.ts:164`) only fires when `status === "completed"`. **Failed tasks are not indexed into memory.** The only record of failure context comes from session summaries (which are generic, not structured) and the `failureReason` field on the task record (which is not searchable via memory-search).

**Impact:** Agents repeat the same mistakes because failure patterns are not preserved in a searchable form.

#### Gap 2: No Structured Reflection Protocol

The default templates say "reflect on what you learned" but provide no **mechanism** to enforce or trigger reflection. Agents are instructed to update identity files and memories, but in practice they rarely do unless explicitly prompted. There is no post-task reflection step in the task lifecycle.

**Impact:** Identity files remain at their default templates for most agents. The Growth Mindset section of SOUL.md is aspirational but not operationalized.

#### Gap 3: No Memory Cleanup or Curation

There are no TTL, capacity limits, or cleanup policies for the memory system. Memories accumulate indefinitely. There is no mechanism to:
- Mark memories as outdated or superseded
- Consolidate related memories into summaries
- Prune low-value or redundant entries

**Impact:** As memory grows, search quality degrades (more noise in results). Session summaries pile up with diminishing returns since they cover every session, not just significant ones.

#### Gap 4: Lead Cannot Inject Learnings into Workers

The lead agent reviews task outputs via follow-up tasks, but has no mechanism to push learnings, corrections, or feedback *back into the worker's memory or identity*. The lead's observations about worker performance are ephemeral — they exist in the lead's session transcript and maybe a session summary, but are not routed to the worker.

**Impact:** The lead spots patterns (e.g., "Researcher always forgets to check CLAUDE.md for repo conventions") but cannot systematically improve the worker's behavior.

#### Gap 5: No Cross-Task Knowledge Transfer

When a worker completes a task, the output is indexed as agent-scoped memory. Other workers cannot search it unless it's explicitly written to `/workspace/shared/memory/`. The lead can see all memories, but workers are siloed.

**Impact:** Worker A's solution to a problem is invisible to Worker B even when they face the same problem. Institutional knowledge concentrates in the lead, not the swarm.

#### Gap 6: No Self-Awareness of Architecture

Agents have no awareness of how they are built. They don't know:
- That their source code lives in the `agent-swarm` repo
- What hooks fire and when
- How their system prompt is assembled
- What the memory system's limitations are (brute-force search, no cleanup, etc.)

**Impact:** When something breaks or behaves unexpectedly, agents cannot debug themselves. They can't propose improvements to their own infrastructure because they don't understand it.

#### Gap 7: Identity Evolution is Unstructured

Agents can edit SOUL.md, IDENTITY.md, CLAUDE.md at any time, but there is no:
- Versioning of identity changes (the DB stores only the latest)
- Review process for identity updates
- Way to diff identity changes across sessions
- Mechanism to roll back problematic identity changes

**Impact:** An agent could corrupt its own identity file in a single bad session, with no way to recover. There's no visibility into how identities evolve over time.

#### Gap 8: Session Summaries are Low-Signal

Session summaries are generated by Claude Haiku from the last 20KB of transcript, with a generic prompt asking for bullet points. The quality varies significantly and often produces surface-level summaries that don't capture the most valuable learnings.

**Impact:** The memory system fills up with generic summaries like "Worked on task X, encountered Y, resolved Z" without capturing the *why* or the *transferable pattern*.

#### Gap 9: No Memory-Informed Prompting

The base prompt tells agents to "use `memory-search` to recall relevant context at session boot," but this is **merely advisory and easily ignored**. There is no enforced mechanism to automatically inject relevant memories into the session context when a new task starts. The agent must manually search — and in practice, almost never does. The instruction needs to be either enforced programmatically (auto-inject at task start) or prompted much more strictly (e.g., as a hard requirement in the task lifecycle, not a suggestion).

**Impact:** Agents start most sessions cold, without leveraging their accumulated knowledge. The entire memory system's value is diminished when retrieval is optional.

#### Gap 10: No Swarm-Level Learning Metrics

There's no way to measure whether the swarm is actually improving. No metrics on:
- Task completion rates over time
- Average task duration trends
- Memory quality/relevance
- Identity file evolution frequency
- Failure recurrence rates

**Impact:** Cannot answer "Is the swarm getting better?" with data.

---

## Proposals

### Tier 1: High Impact, Low Effort

#### P1: Index Failed Tasks into Memory

**Gap addressed:** Gap 1

**Change:** In `store-progress.ts`, extend the memory indexing block (line 164) to also fire when `status === "failed"`. Include the `failureReason` in the content.

```typescript
// Current: only indexes completed tasks
if (status === "completed" && result.success && result.task && output.length > 20) {

// Proposed: also index failed tasks
if ((status === "completed" || status === "failed") && result.success && result.task) {
  const content = status === "completed"
    ? `Task: ${result.task.task}\n\nOutput:\n${output}`
    : `Task: ${result.task.task}\n\nFailure:\n${failureReason}\n\nContext: This task failed. Learn from this to avoid repeating the mistake.`;
```

**Effort:** ~10 lines of code
**Files:** `src/tools/store-progress.ts`

#### P2: Add Architecture Self-Awareness to System Prompt

**Gap addressed:** Gap 6

**Change:** Add a new section to `BASE_PROMPT_FILESYSTEM` (or a new `BASE_PROMPT_SELF_AWARENESS` constant) in `base-prompt.ts` that gives agents essential knowledge about their own infrastructure:

```markdown
### How You Are Built

Your source code lives in the `desplega-ai/agent-swarm` GitHub repository. Key facts:

- **Runtime:** You run as a headless Claude Code process inside a Docker container
- **Orchestration:** A runner process (`src/commands/runner.ts`) polls for tasks and spawns your Claude sessions
- **Hooks:** Six Claude Code hooks fire during your session (SessionStart, PreCompact, PreToolUse, PostToolUse, UserPromptSubmit, Stop) — defined in `src/hooks/hook.ts`
- **Memory:** Your memories are stored in SQLite with OpenAI embeddings (text-embedding-3-small, 512d). Search is brute-force cosine similarity — all matching rows are loaded into memory
- **Identity Sync:** Your SOUL.md, IDENTITY.md, TOOLS.md are synced to the server DB on every file edit (via PostToolUse hook) and on session end (via Stop hook)
- **System Prompt:** Assembled from `src/prompts/base-prompt.ts` + your SOUL.md + IDENTITY.md, passed via `--append-system-prompt`. Your CLAUDE.md is written to `~/.claude/CLAUDE.md` at session start
- **Task Lifecycle:** Tasks go through: unassigned → offered → pending → in_progress → completed/failed. On completion, your output is auto-indexed into memory
- **MCP Server:** Your tools come from an MCP server at `$MCP_BASE_URL`, defined in `src/server.ts`

Use this knowledge to debug issues, propose improvements to yourself, and understand why things work the way they do.
```

**Effort:** ~20 lines added to `src/prompts/base-prompt.ts`
**Files:** `src/prompts/base-prompt.ts`

#### P3: Auto-Promote High-Value Task Completions to Swarm Memory

**Gap addressed:** Gap 5

> **Reviewer note (Taras):** "Shouldn't there be automatic task complete memory creation already?"
>
> **Answer:** Yes — agent-scoped task completion memory **already exists** (`store-progress.ts:164-183`). When a task completes with output > 20 chars, it's automatically indexed as an agent-scoped memory with source `task_completion`. However, this memory is **only visible to the agent that completed the task**. Other workers cannot search it. P3 proposes extending this to also create a **swarm-scoped** copy for high-value completions, so knowledge transfers across agents.

**Change:** When a task completion output is particularly long or contains certain markers (e.g., the task type is `"research"` or the task has a tag `"knowledge"`), also create a swarm-scoped memory copy so other workers can find it.

```typescript
// In store-progress.ts, after creating agent-scoped memory:
const shouldShareWithSwarm =
  result.task.taskType === "research" ||
  result.task.tags?.includes("knowledge") ||
  result.task.tags?.includes("shared") ||
  (output.length > 500); // Research outputs tend to be long

if (shouldShareWithSwarm) {
  await createMemory({
    agentId,
    scope: "swarm",
    name: `Shared: ${result.task.task.substring(0, 80)}`,
    content: `Task completed by ${agentInfo.name}:\n\n${content}`,
    source: "task_completion",
    sourceTaskId: taskId,
  });
}
```

**Effort:** ~20 lines of code
**Files:** `src/tools/store-progress.ts`

#### P4: Improve Session Summary Quality with Structured Prompts

**Gap addressed:** Gap 8

**Change:** Replace the generic summarization prompt in `hook.ts:811-822` with a structured prompt that extracts higher-signal content:

```markdown
You are summarizing an AI agent's work session. Extract ONLY high-value learnings.

DO NOT include:
- Generic descriptions of what was done ("worked on task X")
- Tool calls or file reads
- Routine progress updates

DO include (if present):
- **Mistakes made and corrections** — what went wrong and what fixed it
- **Discovered patterns** — reusable patterns, APIs, or approaches
- **Codebase knowledge** — important file paths, architecture decisions, conventions
- **Environment knowledge** — service URLs, config details, tool versions
- **Failed approaches** — what was tried and didn't work (and why)

Format as a bulleted list. If the session was routine with no significant learnings, respond with just: "No significant learnings."
```

Additionally, skip indexing summaries that return "No significant learnings."

**Effort:** ~15 lines changed
**Files:** `src/hooks/hook.ts`

---

### Tier 2: High Impact, Medium Effort

#### P5: Post-Task Reflection Step

**Gap addressed:** Gap 2

**Change:** After `store-progress` with `status: "completed"` or `"failed"`, inject a brief reflection prompt into the session before it ends. This could be done by having the `/work-on-task` command include a reflection instruction:

In `plugin/commands/work-on-task.md`, add after the completion section:

```markdown
### Post-Task Reflection

After calling `store-progress`, take 30 seconds to reflect:

1. **Did you learn something transferable?** If yes, write it to `/workspace/personal/memory/` or `/workspace/shared/memory/`
2. **Should your IDENTITY.md change?** (new expertise, working style observation)
3. **Should your TOOLS.md change?** (new service, API endpoint, tool preference)
4. **Did you make a mistake worth remembering?** Write it to memory.

Only update files if there's a genuine change — don't write for the sake of writing.
```

**Effort:** ~20 lines in the command definition, plus testing
**Files:** `plugin/commands/work-on-task.md`

#### P6: Lead-to-Worker Feedback Injection

**Gap addressed:** Gap 4

**Change:** Add a new MCP tool `inject-learning` that allows the lead to push a learning or correction into a specific worker's memory:

```typescript
// New tool: inject-learning
registerTool(server, "inject-learning", {
  description: "Push a learning or correction into a worker's memory. Use this when you notice patterns in worker behavior that should be improved.",
  inputSchema: {
    agentId: { type: "string", format: "uuid", description: "Target worker agent ID" },
    learning: { type: "string", description: "The learning to inject" },
    category: { type: "string", enum: ["mistake-pattern", "best-practice", "codebase-knowledge", "preference"], description: "Category of learning" },
  },
  handler: async ({ agentId, learning, category }) => {
    await createMemory({
      agentId,
      scope: "agent",
      name: `Lead feedback: ${category}`,
      content: `[Injected by Lead]\n\nCategory: ${category}\n\n${learning}`,
      source: "manual",
    });
    // Generate embedding
    const embedding = await getEmbedding(learning);
    if (embedding) await updateMemoryEmbedding(memoryId, embedding);
  }
});
```

This could also optionally append to the worker's CLAUDE.md under a "Feedback from Lead" section.

**Effort:** ~80 lines for the tool + tests
**Files:** New `src/tools/inject-learning.ts`, update `src/server.ts`

#### P7: Memory-Informed Task Prompting

**Gap addressed:** Gap 9

**Change:** When the runner builds a prompt for a new task (in `buildPromptForTrigger()` at `runner.ts:793`), automatically search the agent's memories for context relevant to the task description and inject the top results into the prompt:

```typescript
// In buildPromptForTrigger(), after getting task details:
const relevantMemories = await searchMemoriesByVector(
  db, agentId, task.task, { limit: 3, isLead: false }
);

if (relevantMemories.length > 0) {
  const memoryContext = relevantMemories
    .filter(m => m.similarity > 0.4) // Only include genuinely relevant memories
    .map(m => `- ${m.name}: ${m.content.substring(0, 200)}`)
    .join('\n');

  if (memoryContext) {
    prompt += `\n\n## Relevant Past Context\n${memoryContext}`;
  }
}
```

**Effort:** ~40 lines, careful threshold tuning needed
**Files:** `src/commands/runner.ts`

#### P8: Identity Version History *(DEFERRED — "too much for now")*

**Gap addressed:** Gap 7

**Change:** Add an `agent_identity_history` table that stores snapshots of identity files on every sync. The hook's `syncIdentityFilesToServer()` and `syncClaudeMdToServer()` functions would also call a new `createIdentitySnapshot()` function:

```sql
CREATE TABLE IF NOT EXISTS agent_identity_history (
  id TEXT PRIMARY KEY,
  agentId TEXT NOT NULL,
  fileType TEXT NOT NULL CHECK(fileType IN ('soul', 'identity', 'claude', 'tools', 'setup')),
  content TEXT NOT NULL,
  sessionId TEXT,           -- which session made the change
  taskId TEXT,              -- which task context
  createdAt TEXT NOT NULL
);
```

The lead could then query this to see how agents evolve and identify problematic changes. A new MCP tool `identity-history` would let agents review their own evolution.

**Effort:** ~120 lines (schema, snapshot function, MCP tool)
**Files:** `src/be/db.ts`, new `src/tools/identity-history.ts`, `src/hooks/hook.ts`, `src/server.ts`

---

### Tier 3: High Impact, High Effort *(DEFERRED — to be tackled later)*

#### P9: Memory Consolidation and Curation

**Gap addressed:** Gap 3

**Change:** Implement a scheduled task that periodically consolidates the memory system:

1. **Session Summary Consolidation:** Weekly, group all session summaries from the past week and ask Claude Haiku to produce a single consolidated summary. Index the consolidation, delete the individual summaries.

2. **Duplicate Detection:** After indexing a new memory, check if any existing memories have cosine similarity > 0.9 (near-duplicates). If found, merge or flag for review.

3. **Staleness Scoring:** Track `accessedAt` to identify memories that are never retrieved. After N days without access, reduce their search weight or archive them.

4. **Memory Budget:** Implement a soft cap (e.g., 500 memories per agent). When exceeded, trigger consolidation of the oldest/least-accessed memories.

This would be implemented as a new `src/scheduler/memory-consolidation.ts` module that runs as a scheduled task.

**Effort:** ~300 lines + significant testing
**Files:** New `src/scheduler/memory-consolidation.ts`, update `src/be/db.ts`, `src/scheduler/scheduler.ts`

#### P10: Swarm Learning Dashboard

**Gap addressed:** Gap 10

**Change:** Add API endpoints and UI components to visualize swarm learning metrics:

- **Memory Growth:** Charts showing memory accumulation per agent over time
- **Identity Evolution:** Timeline of identity file changes with diffs
- **Task Performance:** Completion rates, duration trends, failure rates per agent
- **Memory Quality:** Search hit rates, which memories are accessed most
- **Knowledge Graph:** Visual representation of what topics each agent has expertise in (derived from memory content)

This would be a new section in the existing UI (`new-fe/`) with dedicated API endpoints in `src/http.ts`.

**Effort:** ~500+ lines backend + frontend
**Files:** `src/http.ts`, `new-fe/src/pages/`, `new-fe/src/components/`

#### P11: Structured Learning Loops via Scheduled Retrospectives

**Gap addressed:** Gaps 2, 3, 10

**Change:** Create pre-built scheduled tasks that enforce periodic self-improvement:

1. **Weekly Retrospective (per agent):** A scheduled task assigned to each worker that runs weekly:
   ```
   Review your last 7 days of task completions and session summaries.
   1. Search your memories for the past week's work.
   2. Identify the top 3 learnings.
   3. Update your IDENTITY.md if your expertise has grown.
   4. Update your TOOLS.md if you discovered new tools/services.
   5. Write a consolidated summary to /workspace/shared/memory/weekly-{agent}-{date}.md
   ```

2. **Monthly Swarm Review (lead):** A scheduled task for the lead:
   ```
   Review all workers' recent task outputs and identity changes.
   1. Use memory-search with scope "all" to find patterns.
   2. Identify workers who need coaching.
   3. Use inject-learning to push corrections.
   4. Write a swarm health report to /workspace/shared/memory/.
   ```

3. **Daily Knowledge Digest (lead):** A lighter daily task:
   ```
   Scan completed tasks from the last 24 hours.
   Identify any knowledge that should be promoted to swarm-scoped memory.
   ```

These would be set up as default schedules when a swarm is first initialized.

**Effort:** ~150 lines (schedule templates, documentation)
**Files:** `src/scheduler/`, `plugin/commands/`, documentation

---

## Implementation Priority

Based on review feedback and impact/effort ratio:

### Approved (see [Implementation Plan](#implementation-plan) below)

| Priority | Proposal | Effort | Impact | Status |
|----------|----------|--------|--------|--------|
| 1 | **P1: Index Failed Tasks** | ~10 lines | Immediate: failure knowledge preserved | Approved |
| 2 | **P4: Better Session Summaries** | ~15 lines | Immediate: higher signal in memory | Approved |
| 3 | **P2: Architecture Self-Awareness** | ~20 lines | Immediate: agents can debug themselves | Approved |
| 4 | **P5: Post-Task Reflection** | ~20 lines | Medium-term: structured learning habit | Approved |
| 5 | **P7: Memory-Informed Prompting** | ~40 lines | High: agents start warm instead of cold | Approved |
| 6 | **P6: Lead-to-Worker Feedback** | ~80 lines | High: closes the lead→worker learning loop | Approved |

### Not planned (existing feature — see P3 note)

| | **P3: Auto-Promote to Swarm Memory** | ~20 lines | Medium-term: cross-agent knowledge | Agent-scoped already exists; swarm promotion is a future enhancement |

### Deferred

| | **P8: Identity Version History** | ~120 lines | Medium: safety net + visibility | Deferred: "too much for now" |
| | **P9-P11: Tier 3 items** | 300-500+ lines | Various | Deferred: to be tackled later |

---

## Implementation Plan

Concrete, ordered implementation steps for each approved proposal. Each step is designed to be a single, reviewable PR or commit.

### Phase 1: Quick Wins (P1, P4, P2) — Tier 1

These are small, self-contained changes that can be shipped independently with minimal risk.

#### Step 1.1: Index Failed Tasks into Memory (P1)

**File:** `src/tools/store-progress.ts`
**Change:** Extend the memory indexing guard at line 164 to also fire on `status === "failed"`.

1. Change the condition from `status === "completed"` to `(status === "completed" || status === "failed")`
2. Remove the `output.length > 20` guard for failed tasks (failure reason may be short but still valuable)
3. Format the memory content differently for failures vs completions:
   - Completed: `Task: {description}\n\nOutput:\n{output}`
   - Failed: `Task: {description}\n\nFailure Reason:\n{failureReason}\n\nThis task failed — index this to avoid repeating the mistake.`
4. Use source `"task_completion"` for both (existing source type, no schema change needed)

**Testing:** Create a task, fail it with `store-progress`, verify a memory is created with `memory-search`.

#### Step 1.2: Improve Session Summary Prompts (P4)

**File:** `src/hooks/hook.ts` (around line 811-822)
**Change:** Replace the generic summarization prompt with a structured extraction prompt.

1. Replace the current prompt with one that:
   - Explicitly instructs "DO NOT include generic descriptions of what was done"
   - Lists specific categories to extract: mistakes, patterns, codebase knowledge, failed approaches
   - Allows returning "No significant learnings." for routine sessions
2. Add a guard after summarization: if the response is exactly "No significant learnings.", skip memory indexing for that session
3. Keep the existing 20KB transcript limit and Haiku model

**Testing:** End a session, verify the summary is more structured. End a trivial session, verify no memory is created.

#### Step 1.3: Add Architecture Self-Awareness (P2)

**File:** `src/prompts/base-prompt.ts`
**Change:** Add a new `BASE_PROMPT_SELF_AWARENESS` constant with key architectural facts.

1. Create the constant with essential info: runtime environment, hooks list, memory system details, identity sync lifecycle, system prompt assembly, task lifecycle
2. Include it in the prompt assembly (both lead and worker variants)
3. Keep it concise — facts only, no opinions. Target ~15 lines of markdown

**Testing:** Start a new session, ask the agent "how is your system prompt assembled?" — it should be able to answer accurately.

### Phase 2: Behavioral Changes (P5, P7) — Tier 2 (prompt/plugin)

These changes modify agent behavior through prompt/command changes rather than code.

#### Step 2.1: Post-Task Structured Reflection (P5)

**File:** `plugin/commands/work-on-task.md`
**Change:** Add a "Post-Task Reflection" section to the completion workflow.

1. After the "Completion" section, add a mandatory reflection checklist:
   - Did you learn something transferable? → Write to memory
   - Should IDENTITY.md change? → Update it
   - Should TOOLS.md change? → Update it
   - Did you make a mistake worth remembering? → Write to memory
2. Make it clear this is a **requirement**, not a suggestion: "You MUST check each item before finishing"
3. Add a guard: "Only update files if there's a genuine, non-trivial change"

**Testing:** Complete a task, verify the agent goes through the reflection checklist. Check that it doesn't write empty/boilerplate updates.

#### Step 2.2: Memory-Informed Task Prompting (P7)

**File:** `src/commands/runner.ts` (in `buildPromptForTrigger()`)
**Change:** Auto-inject relevant memories when building a task prompt.

1. After resolving the task description, call `searchMemoriesByVector()` with the task text
2. Filter results to similarity > 0.4 (tune this threshold — too low = noise, too high = misses)
3. Limit to top 3 results
4. Format as a "## Relevant Past Context" section appended to the prompt
5. Include memory name and a 200-char content preview for each
6. If no memories pass the threshold, omit the section entirely

**Testing:** Create a task similar to a previously completed one. Verify the prompt includes relevant memory context. Verify irrelevant memories are filtered out.

### Phase 3: New Tool (P6) — Tier 2 (code)

This is the most complex approved change — a new MCP tool.

#### Step 3.1: Lead-to-Worker Feedback Loop (P6)

**Files:** New `src/tools/inject-learning.ts`, update `src/server.ts`
**Change:** New MCP tool allowing the lead to push learnings into worker memory.

1. Create `inject-learning` tool with parameters:
   - `agentId` (required): target worker
   - `learning` (required): the learning text
   - `category` (required): one of `mistake-pattern`, `best-practice`, `codebase-knowledge`, `preference`
2. The tool should:
   - Validate the caller is a lead agent
   - Create an agent-scoped memory for the target worker with source `"manual"` and a clear `[Injected by Lead]` prefix
   - Generate and store an embedding for the learning
   - Return a confirmation with the memory ID
3. Register the tool in `src/server.ts` (lead-only capability)
4. Optionally: also append to the target worker's CLAUDE.md under a "## Lead Feedback" section (this makes it visible on next session boot without requiring memory search)

**Testing:** As lead, inject a learning into a worker. As the worker, search memories — verify it appears. Start a new session as the worker — verify the CLAUDE.md note is present.

### Implementation Order Summary

```
Phase 1 (can be parallelized):
  1.1 P1: Failed task memory indexing     (~10 lines, store-progress.ts)
  1.2 P4: Session summary quality         (~15 lines, hook.ts)
  1.3 P2: Architecture self-awareness     (~20 lines, base-prompt.ts)

Phase 2 (depends on Phase 1 for P7, independent for P5):
  2.1 P5: Post-task reflection            (~20 lines, work-on-task.md)
  2.2 P7: Memory-informed prompting       (~40 lines, runner.ts)

Phase 3 (independent):
  3.1 P6: Lead feedback injection         (~80 lines, new tool + server registration)
```

Total estimated effort: ~185 lines of code across 6 steps.

---

## Appendix: Current Code References

### Memory System
- Database schema: `src/be/db.ts:372-401`
- Embedding generation: `src/be/embedding.ts:15-37` (OpenAI text-embedding-3-small, 512d)
- Vector search: `src/be/db.ts:5088-5148` (brute-force cosine similarity, loads all rows)
- Content chunking: `src/be/chunking.ts:18` (markdown-aware, 2000-char chunks)
- Memory search MCP tool: `src/tools/memory-search.ts:8`
- Memory get MCP tool: `src/tools/memory-get.ts:7`
- Auto-indexing hook: `src/hooks/hook.ts:700-733`
- Session summary hook: `src/hooks/hook.ts:782-874`
- Task completion indexing: `src/tools/store-progress.ts:163-183`
- HTTP ingestion API: `src/http.ts:2288-2376`

### Identity System
- Default template generators: `src/be/db.ts:2342-2528`
- Profile update tool: `src/tools/update-profile.ts:7-216`
- Identity file sync (PostToolUse): `src/hooks/hook.ts:673-698`
- Identity file sync (Stop): `src/hooks/hook.ts:770-780`
- CLAUDE.md injection (SessionStart): `src/hooks/hook.ts:609-623`
- Runner profile fetch + file write: `src/commands/runner.ts:1670-1789`

### System Prompt
- Base prompt construction: `src/prompts/base-prompt.ts:328-386`
- Role-specific prompts: `src/prompts/base-prompt.ts:11-202` (lead) and `183-202` (worker)
- Filesystem instructions: `src/prompts/base-prompt.ts:204-258`
- Runner prompt assembly: `src/commands/runner.ts:1558-1607`

### Task Lifecycle
- Task creation: `src/be/db.ts:1992-2059`
- Task polling: `src/http.ts:529-666`
- store-progress: `src/tools/store-progress.ts:64-237`
- Follow-up task creation: `src/tools/store-progress.ts:188-227`
- Runner task loop: `src/commands/runner.ts:1896-2022`

### Hooks
- Hook handler: `src/hooks/hook.ts:174-891`
- Hook configuration: `plugin/hooks/hooks.json`
- PreCompact goal reminder: `src/hooks/hook.ts:625-648`
- Cancellation detection: `src/hooks/hook.ts:456-490`
