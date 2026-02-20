---
date: 2026-02-20T20:00:00Z
topic: "Agent Self-Improvement Implementation Plan"
status: draft
author: Researcher
---

# Plan: Agent Self-Improvement Implementations

**Research:** `thoughts/researcher/research/2026-02-20-agent-self-improvement.md`
**Repository:** desplega-ai/agent-swarm

---

## Overview

Implementation plan for the 7 approved proposals from the agent self-improvement research. Ordered by effort (smallest first) to maximize early wins.

**Approved proposals:** P1, P2, P3, P4, P5, P6, P7
**Deferred:** P8, P9, P10, P11

---

## Phase 1: Quick Wins (P1, P4) — ~25 lines total

### Step 1.1: Index Failed Tasks into Memory (P1)

**File:** `src/tools/store-progress.ts`
**Location:** Line 163-184 (existing task completion indexing block)

**Change:** Extend the condition to also fire for `status === "failed"` and include the failure reason in the indexed content.

```typescript
// Replace line 164:
if (status === "completed" && result.success && result.task && output && output.length > 20) {
// With:
if ((status === "completed" || status === "failed") && result.success && result.task) {
```

Then adjust the content construction:
```typescript
const taskContent = status === "completed"
  ? `Task: ${result.task!.task}\n\nOutput:\n${output}`
  : `Task: ${result.task!.task}\n\nFailure reason:\n${failureReason}\n\nThis task failed. Learn from this to avoid repeating the mistake.`;

// Only skip indexing if there's truly no content
if (taskContent.length < 30) return;
```

**Test:** Create a failing task, verify it appears in `memory-search` results.

### Step 1.2: Improve Session Summary Quality (P4)

**File:** `src/hooks/hook.ts`
**Location:** Line 811-822 (session summary prompt)

**Change:** Replace the generic summarization prompt with a structured one that extracts only high-value learnings.

New prompt:
```
You are summarizing an AI agent's work session. Extract ONLY high-value learnings.

DO NOT include:
- Generic descriptions of what was done ("worked on task X")
- Tool calls or file reads
- Routine progress updates

DO include (if present):
- **Mistakes made and corrections** — what went wrong and what fixed it
- **Discovered patterns** — reusable approaches, APIs, or codebase conventions
- **Codebase knowledge** — important file paths, architecture decisions, gotchas
- **Environment knowledge** — service URLs, config details, tool quirks
- **Failed approaches** — what was tried and didn't work (and why)

Format as a bulleted list of concrete, reusable facts. If the session was routine with no significant learnings, respond with exactly: "No significant learnings."
```

Additionally, after generating the summary, skip indexing if the response is "No significant learnings."

**Test:** End a routine session, verify no generic summary is indexed. End a session with a real learning, verify it captures the specific insight.

---

## Phase 2: Self-Awareness & Reflection (P2, P5) — ~40 lines total

### Step 2.1: Add Architecture Self-Awareness to System Prompt (P2)

**File:** `src/prompts/base-prompt.ts`
**Location:** After the existing filesystem instructions section (~line 258)

**Change:** Add a new `BASE_PROMPT_SELF_AWARENESS` constant (or append to `BASE_PROMPT_FILESYSTEM`) with a concise block:

```markdown
### How You Are Built

Your source code lives in the `desplega-ai/agent-swarm` GitHub repository. Key facts:

- **Runtime:** Headless Claude Code process inside a Docker container
- **Orchestration:** Runner process (`src/commands/runner.ts`) polls for tasks and spawns sessions
- **Hooks:** Six hooks fire during your session (SessionStart, PreCompact, PreToolUse, PostToolUse, UserPromptSubmit, Stop) — see `src/hooks/hook.ts`
- **Memory:** SQLite + OpenAI embeddings (text-embedding-3-small, 512d). Search is brute-force cosine similarity
- **Identity Sync:** SOUL.md/IDENTITY.md/TOOLS.md synced to DB on file edit (PostToolUse) and session end (Stop)
- **System Prompt:** Assembled from base-prompt.ts + SOUL.md + IDENTITY.md, passed via --append-system-prompt
- **Task Lifecycle:** unassigned → offered → pending → in_progress → completed/failed. Completed output auto-indexed into memory
- **MCP Server:** Tools come from MCP server at $MCP_BASE_URL (src/server.ts)

Use this to debug issues and propose improvements to your own infrastructure.
```

Include this in the prompt for both lead and worker roles.

**Test:** Start a new session, ask the agent "how does your memory system work?" — verify it answers from the self-awareness block rather than guessing.

### Step 2.2: Post-Task Reflection Step (P5)

**File:** `plugin/commands/work-on-task.md`
**Location:** After the "Completion" section

**Change:** Add a mandatory reflection step to the work-on-task command:

```markdown
### Post-Task Reflection (REQUIRED)

After calling `store-progress` to complete or fail a task, do the following before finishing:

1. **Transferable learning?** If you learned something reusable (a pattern, a gotcha, a fix), write it to `/workspace/personal/memory/<descriptive-name>.md`
2. **Swarm-relevant?** If the learning applies to all agents (not just you), write it to `/workspace/shared/memory/<descriptive-name>.md` instead
3. **Identity update?** If you discovered a new area of expertise or working style preference, update your IDENTITY.md
4. **Tools update?** If you found a new service, API, or tool, update your TOOLS.md

Skip this section ONLY if the task was trivially simple (single file edit, no debugging, no new knowledge gained).
```

**Test:** Complete a non-trivial task, verify the agent performs reflection before calling DONE.

---

## Phase 3: Cross-Agent Knowledge (P3, P6, P7) — ~135 lines total

### Step 3.1: Auto-Promote High-Value Completions to Swarm Memory (P3)

**File:** `src/tools/store-progress.ts`
**Location:** After line 183 (after the existing agent-scoped memory creation)

**What already exists:** Agent-scoped memory is created for every completed task with output > 20 chars.

**Change:** Add a swarm-scoped memory creation for completions that match specific criteria:

```typescript
// After the existing agent-scoped memory block:
const shouldShareWithSwarm =
  result.task.taskType === "research" ||
  result.task.tags?.includes("knowledge") ||
  result.task.tags?.includes("shared");

if (shouldShareWithSwarm) {
  try {
    const swarmMemory = createMemory({
      agentId: requestInfo.agentId,
      scope: "swarm",
      name: `Shared: ${result.task!.task.slice(0, 80)}`,
      content: `Task completed by agent ${requestInfo.agentId}:\n\n${taskContent}`,
      source: "task_completion",
      sourceTaskId: taskId,
    });
    const swarmEmbedding = await getEmbedding(taskContent);
    if (swarmEmbedding) {
      updateMemoryEmbedding(swarmMemory.id, serializeEmbedding(swarmEmbedding));
    }
  } catch {
    // Non-blocking
  }
}
```

**Test:** Complete a task with `taskType: "research"`, verify a swarm-scoped memory is created alongside the agent-scoped one. Search from a different agent to confirm visibility.

### Step 3.2: Lead-to-Worker Feedback Injection (P6)

**Files:**
- New file: `src/tools/inject-learning.ts`
- Update: `src/server.ts` (register the tool)

**Change:** Create a new MCP tool that allows the lead to push learnings into a worker's memory.

Tool schema:
- `agentId` (string, uuid, required): Target worker
- `learning` (string, required): The learning content
- `category` (string, enum: ["mistake-pattern", "best-practice", "codebase-knowledge", "preference"], required)

Handler logic:
1. Validate the caller is the lead agent
2. Create an agent-scoped memory for the target worker with source `"manual"` and prefix `[Lead Feedback]`
3. Generate and store the embedding
4. Return confirmation

```typescript
const content = `[Lead Feedback — ${category}]\n\n${learning}`;
const memory = createMemory({
  agentId: targetAgentId,
  scope: "agent",
  name: `Lead feedback: ${category} — ${learning.slice(0, 60)}`,
  content,
  source: "manual",
});
```

**Test:** As lead, inject a learning. Search the worker's memories to verify it appears.

### Step 3.3: Memory-Informed Task Prompting (P7)

**File:** `src/commands/runner.ts`
**Location:** `buildPromptForTrigger()` at ~line 793, after getting task details

**Change:** Before spawning the session, search the agent's memories for content relevant to the task description and append the top results to the prompt.

```typescript
try {
  const relevantMemories = await searchMemoriesByVector(
    db, agentId, task.task, { limit: 5, isLead: false }
  );
  const useful = relevantMemories.filter(m => m.similarity > 0.4);
  if (useful.length > 0) {
    const memoryContext = useful
      .map(m => `- **${m.name}**: ${m.content.substring(0, 300)}`)
      .join('\n');
    prompt += `\n\n### Relevant Past Knowledge\n\nThese memories from your previous sessions may be useful:\n\n${memoryContext}\n`;
  }
} catch {
  // Non-blocking — don't fail task start because of memory search
}
```

**Considerations:**
- Similarity threshold (0.4) needs tuning — too low adds noise, too high misses relevant context
- Content truncation (300 chars) prevents memory blocks from dominating the prompt
- Limit to 5 results to keep prompt size reasonable
- Wrap in try/catch so memory failures don't block task execution

**Test:** Create a memory about a specific topic. Start a task about that topic. Verify the memory appears in the session's initial context.

---

## Implementation Order Summary

| Order | Proposal | Phase | Files Modified | Estimated Lines |
|-------|----------|-------|----------------|-----------------|
| 1 | P1: Index Failed Tasks | 1 | `store-progress.ts` | ~10 |
| 2 | P4: Better Session Summaries | 1 | `hook.ts` | ~15 |
| 3 | P2: Architecture Self-Awareness | 2 | `base-prompt.ts` | ~20 |
| 4 | P5: Post-Task Reflection | 2 | `work-on-task.md` | ~20 |
| 5 | P3: Auto-Promote to Swarm Memory | 3 | `store-progress.ts` | ~15 |
| 6 | P6: Lead-to-Worker Feedback | 3 | new `inject-learning.ts`, `server.ts` | ~80 |
| 7 | P7: Memory-Informed Prompting | 3 | `runner.ts` | ~40 |

**Total estimated:** ~200 lines across 6 files (1 new)

---

## Testing Strategy

Each proposal should be tested individually before moving to the next:

1. **P1:** Fail a task intentionally → `memory-search` for failure context
2. **P4:** End sessions with varying complexity → verify summary quality
3. **P2:** Start fresh session → ask agent about its own architecture
4. **P5:** Complete a learning-heavy task → verify reflection artifacts
5. **P3:** Complete research task → verify swarm-scoped memory exists
6. **P6:** Lead injects feedback → worker session finds it via memory-search
7. **P7:** Create memories → start task → verify memories in initial prompt

---

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Memory noise from indexing failures | P1 includes `failureReason` which is structured; minimum content length check |
| Session summary prompt too restrictive | "No significant learnings" escape hatch prevents forced hallucination |
| Self-awareness block becomes stale | Block references file paths, not implementation details |
| Memory-informed prompting adds latency | Non-blocking, try/catch wrapped, limited to 5 results |
| Swarm memory pollution from P3 | Tag-based promotion (not length-based) requires explicit opt-in |
