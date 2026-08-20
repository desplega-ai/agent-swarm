---
date: 2026-08-20
topic: Canonical memory story for the v2 system prompt (collapsing 4 overlapping instructions)
status: complete
inputs:
  - runbooks/memory-system.md
  - thoughts/taras/plans/2026-08-20-system-prompt-slimdown-proposal.md (decision #2, open)
  - thoughts/taras/research/2026-07-30-agent-profile-files-memory-integration.md
---

# Memory story research: what should the v2 prompt say

## 1. Recall paths

| Path | Trigger | Default-on? | Key params | Files |
|---|---|---|---|---|
| Runner injection ("Relevant Past Knowledge") | Every `task_assigned` / `task_offered` trigger, for every harness (not gated by adapter/provider) | **Yes**, unconditionally, no env flag | `limit=5`, `intent: "pre-task memory recall"`, only memories with `similarity > 0.4` render; headers `X-Source-Task-ID` (for rater logging) and `X-Context-Key` when the task carries one | `fetchRelevantMemories` `src/commands/runner.ts:2957-2994`, call sites `runner.ts:5855-5867` (fresh task) and `runner.ts:5397` (resume); render logic `src/prompts/memories.ts:1-50` (`SIMILARITY_THRESHOLD = 0.4`) |
| `memory-search` MCP tool | Agent calls it explicitly | Opt-in (tool call); text instructing agents to call it is default-on in the prompt (see below) | `query`, required `intent`, `scope: all\|agent\|swarm`, `limit` (default 10, max 50); vector search → default-on 1-hop `memory_link` graph expansion (`MEMORY_GRAPH_EXPANSION`, default on) → `rerank()` | `src/tools/memory-search.ts:66-198`; graph expansion `src/be/memory/graph-expansion.ts:72`; reranker `src/be/memory/reranker.ts:93` |
| `memory-get` | Agent calls it to fetch full content by ID | Opt-in | — | `src/tools/memory-get.ts` |
| `memory_rate` | Agent flags a retrieved memory useful/misleading | Opt-in; prompt hint only appears when `MEMORY_RATERS` includes `explicit-self` (env default empty → hint absent) | Feeds Beta `(α,β)` posterior via `applyRating` | `src/tools/memory-rate.ts`; hint text `src/prompts/memories.ts` `RATE_TOOL_HINT` |
| `task-context-gathering` seed script | Agent runs it manually via `script-run` | Opt-in (deferred tool, agent must call) | Wraps `task_get` + N `memory_search` calls, dedups, composite-reranks (`similarity + 0.05*hits`) | `src/be/seed-scripts/catalog/task-context-gathering.ts:39-92` |
| `smart-recall` seed script | Agent runs it manually | Opt-in | Same fan-out-dedup pattern, memory-only (no task fetch) | `src/be/seed-scripts/catalog/smart-recall.ts:21-61` |
| SessionStart hook | Session boot | N/A — **does not recall memory**. Loads agent's `CLAUDE.md`, injects lead "concurrent session awareness", clears tool-loop history. No memory-search call. | — | `src/hooks/hook.ts:1052-1127` |
| PreCompact hook | Before context compaction | N/A — **does not recall memory**. Injects a goal reminder built from `task.task` + `task.progress` fetched by task ID, not a memory search. | — | `src/hooks/hook.ts:1129-1152` |

Ranking formula (server-side, applies to `memory-search` and therefore to `task-context-gathering`/`smart-recall`, but **not** to the runner injection which is a flat top-5 similarity cut):

```
usefulness(α, β) = clamp(2·α/(α+β), MEMORY_DEMOTION_FLOOR=1.0, 2.0)
score = similarity × recency_decay(source) × access_boost × source_quality(source) × usefulness(α, β)
```
Raters that feed `(α,β)` are gated by `MEMORY_RATERS` (default `""` = all off, byte-identical to pre-rater behavior): `implicit-citation` (server, at task completion), `llm` (worker, piggybacks the Stop-hook summary), `explicit-self` (worker, `memory_rate` tool). Source: `runbooks/memory-system.md:15-67`.

**Default-on verdict:** only the runner injection (d) and the underlying ranking machinery (hybrid FTS+vec, graph expansion) are default-on with zero agent action. Everything an agent must *call* — `memory-search`, `memory-get`, `memory_rate`, `task-context-gathering`, `smart-recall` — is opt-in; the prompt text telling agents to call them is what makes recall happen in practice today.

## 2. Write paths

| Path | Trigger | Default-on? | Scope/notes | Files |
|---|---|---|---|---|
| PostToolUse file-write indexing | Write/Edit to `/workspace/personal/memory/*` or `/workspace/shared/memory/<agentId>/*` | **Yes, but only where the hook mechanism exists**: claude (`hook.ts`), pi (`pi-mono-extension.ts:188-209` per research doc), opencode (`plugin/opencode-plugins/agent-swarm.ts:133-154`). **Not present for codex** (no file-indexing hook — confirmed by research doc and by absence in `codex-hook.ts`, which only does steering). **Not applicable to devin/claude-managed** — no `/workspace`, `hasLocalEnvironment: false`. | `source: "file_index"`, scope `agent` or `swarm` by path prefix | `src/hooks/hook.ts:1252-1285`; opencode `plugin/opencode-plugins/agent-swarm.ts:133-154` |
| `store-progress` task-completion memory | Every `status: completed\|failed` call to `store-progress` | **Yes for manual tasks by default.** Automatic/recurring tasks (schedule/system source, `scheduled`/`auto-generated` tags, or taskType in {boot-triage, heartbeat, heartbeat-checklist, health-check, health-probe, monitor, monitoring, `*-monitor`, `*-digest`}) are **skipped unless `persistMemory: true`** is passed. Universal — this is an MCP tool call, works on every harness including devin/claude-managed. | Writes `source: "task_completion"`; auto-promotes to `scope: "swarm"` when `taskType === "research"` or tags include `knowledge`/`shared` | `src/tools/store-progress.ts:342-409`; gate logic `src/memory/automatic-task-gate.ts:1-48` |
| Session-summary write (Stop / turn-end) | Session/turn ends | **Yes by default** (`SKIP_SESSION_SUMMARY` env opts out) — implemented per-provider: claude (`hook.ts` Stop case, `runStopHookSessionSummarySubprocess`), codex (`codex-adapter.ts:1292-1390`), pi (`pi-mono-extension.ts:299-401`), opencode (`plugin/opencode-plugins/lib/summarize.ts` via `summarizeSessionForOpencode`). **Not implemented for devin or claude-managed** — no adapter-side call to `/api/memory/index` found in `devin-adapter.ts` or `claude-managed-adapter.ts`. | `source: "session_summary"`, scope `agent`; skipped if summary <20 chars or says "no significant learnings" | `src/hooks/hook.ts:320-445` |
| Dreaming add-on | Nightly `dream-daily` workflow, applies memory-delta lane via `inject_learning` | **Not shipped** — lives on the unmerged `dreaming` branch (confirmed: `git log main` has zero `dream` commits; main tree has no `dream-daily` workflow, no `ADDONS` config, no `inject_learning` caller in `src`). Out of scope for "today's" story. | Would write `swarm`-scope memories only, per plan | branch `dreaming`; local memory note `project_dreaming_addon.md` |
| Profile → memory integration | Would fan-in `agents.soulMd/identityMd/toolsMd/...` into `agent_memory` on every profile write | **Not shipped** — research-only (`thoughts/taras/research/2026-07-30-agent-profile-files-memory-integration.md`), decisions recorded but no plan/implementation exists yet | Would add `source: "profile"`, unratable | see §3 below |
| Explicit "write a new memory" MCP/script tool | — | **Does not exist.** `memory-edit` requires an existing `memoryId` or `key+scope` (in-place edit only, see `src/tools/memory-edit.ts:42-94`) — it cannot create a row. `POST /api/memory/index` exists at the HTTP layer (`src/http/memory.ts:45`) but is **not** in the script SDK allowlist (`src/scripts-runtime/sdk-allowlist.ts` exposes only `memory_search`, `memory_get`, `memory_edit`, `memory_rate`, `memory_delete`) and has no MCP tool wrapper. | — | — | — |

**Default-on verdict:** `store-progress` task-completion write is the only write path that is both default-on and universal across every harness and remote provider. File-write indexing and session-summary writes are default-on but harness-dependent (missing pieces: codex has no file-index hook; devin/claude-managed have neither).

## 3. Decided direction (from research + open plan)

1. **Hybrid prompt/recall is the confirmed direction** (profile-memory research, decision #8, 2026-07-30 file-review): identity core (SOUL.md/IDENTITY.md) stays verbatim in the prompt; everything else — including a future `profile`-sourced memory — is recallable via `memory-search`, with the runner injection as the automatic path and explicit search as the fallback for older/deeper context. The 2026-08-20 slimdown proposal (decision #2, marked "lets align on this" by Taras, still open) explicitly assumes "the runner-injected block is primary, explicit `memory-search` is secondary" and asks to confirm — this research confirms that assumption matches the shipped code today.
2. **`todos.md` is deprecated** (profile-memory research, decision #9): not integrated into memory/profile; removal of the docker-entrypoint creation block and the `todos` skill is a separate, already-decided cleanup.
3. **Profile → memory fan-in is designed but not built**: server-side fan-in at `updateAgentProfile()`, bidirectional (memory-edit write-back to profile), new `source: "profile"` value (top-tier reranking, TTL null, protected, **not ratable — fails loudly**), linked to the agent via a `memory_link` external target. This is future work, not part of today's story.
4. **Dreaming (nightly self-improvement workflow) is designed and reviewed but unmerged** — it would add a memory-delta write lane (`inject_learning`, swarm-scope only) once shipped. Not part of today's canonical story.
5. **Graph expansion and hybrid search have already shipped and defaulted on** (memory-retrieval-v2, PR #894): `MEMORY_GRAPH_EXPANSION` and `MEMORY_HYBRID_SEARCH` both default to enabled (`src/be/memory/constants.ts:68-77`) — the v2 prompt can describe recall as "hybrid + graph-expanded" without a caveat.

## 4. Redundancy verdict

Today four places tell an agent to recall memory at task start:

- (a) `system.agent.filesystem` § Memory — "REQUIRED... At the start of EVERY task, you MUST use `memory-search`" (`src/prompts/session-templates.ts:289`)
- (b) `system.agent.seed_scripts` — "At every task start (do this FIRST): Run `task-context-gathering`" (`src/prompts/session-templates.ts:615`)
- (c) `plugin/commands/work-on-task.md` step 2 — "Recall relevant memories: Use `memory-search`..." (`plugin/commands/work-on-task.md:14`), reached only via the `/work-on-task` slash command
- (d) Runner injection — `### Relevant Past Knowledge` appended to the trigger prompt automatically (`src/prompts/memories.ts`)

**(d) already fires for every task, on every harness, before the agent does anything.** (a), (b), (c) are three separate written instructions telling the agent to do a thing that already partially happened. Worse, (a) and (c) both point at the *same* single-query `memory-search` tool, while (b) points at a *different, better* tool (`task-context-gathering`, which also replaces the `get-task-details` call (c) makes in step 1) — so (a)/(c) are not just redundant with (d), they're redundant with (b) too, and give worse guidance (single query vs. 2-4 query fan-out with dedup).

**Minimal instruction set:**
- Keep one line stating recall is automatic: relevant past memories are injected into the task prompt already.
- Keep one pointer to the seed script (`task-context-gathering` / `smart-recall`) for agents who want a deeper, multi-angle search than the automatic top-5 — this is the single "if you want more, do this" instruction, replacing both (a) and (c).
- Delete the REQUIRED-at-every-task language in (a) and the duplicate line in (c) (`work-on-task.md` step 2 becomes redundant with step 1 once `task-context-gathering` folds `get-task-details` in — consider collapsing (c)'s steps 1+2 into one `task-context-gathering` call instead of deleting it outright, since `/work-on-task` is a distinct entry point from the system prompt).
- Keep the write-path guidance (write files to the memory dirs / call `store-progress` on completion) — that part is not redundant with anything.

**Non-Claude harnesses / remote providers:**
- The runner injection (d) is provider-agnostic — it fires in the shared trigger-building path in `runner.ts` regardless of `harnessProvider`, so pi, codex, opencode, devin, and claude-managed all get it.
- (a) and (b) are delivered via the `system.agent.filesystem` / `system.agent.seed_scripts` templates, which are only included in the `worker`/`lead`/`worker.pi`/`lead.pi` composites. The **remote composite** (`system.session.worker.remote`, used for devin/claude-managed) does **not** include either block (`src/prompts/session-templates.ts:1016-1029`) — so today devin/claude-managed agents never see instructions (a) or (b) at all, only (d).
- (c) is a Claude Code plugin slash command; it is not available to codex/opencode/pi/devin/claude-managed sessions in the same form (codex gets an equivalent via `build:pi-skills`-generated pi-skills / AGENTS.md content, but the exact file differs).
- Write side: codex has no PostToolUse file-index hook (only `store-progress` and its own session-summary write). Devin/claude-managed have neither a file-index hook nor a session-summary write — `store-progress` task-completion is their *only* memory write path. Any v2 prompt text that says "write learnings to `/workspace/personal/memory/`" is misleading for these two providers since the directory doesn't exist for them.

## Recommended one-paragraph prompt text (memory section, ≤80 words)

> Relevant memories from past sessions are automatically added to your task prompt — check there first. For a deeper or multi-angle search, run the `task-context-gathering` seed script (task ID + 2-4 queries) instead of `memory-search` directly; it replaces both. To save a learning: write a file to `/workspace/personal/memory/` (or `/workspace/shared/memory/<agentId>/` to share it) — it's indexed automatically. Completed tasks are indexed too.

(72 words. Providers without `/workspace` — devin, claude-managed — should get the write-path sentence dropped or replaced with "learnings persist via your task's completed output"; that's a template-branch decision for implementation, not a wording tweak.)

## What to delete

- `src/prompts/session-templates.ts:289` — the "REQUIRED... At the start of EVERY task, you MUST use `memory-search`" paragraph in `system.agent.filesystem` § Memory. Replace with the automatic-recall sentence above.
- `src/prompts/session-templates.ts:615` — narrow "do this FIRST" framing in `system.agent.seed_scripts`; fold into the one-paragraph memory section instead of keeping it as a separate "pre-built scripts" callout for this specific case (the rest of the seed-scripts block, e.g. `delegate`/`wait-for-task`, stays).
- `plugin/commands/work-on-task.md:14` — step 2 "Recall relevant memories: Use `memory-search`..."; either delete or replace with a `task-context-gathering` call that also subsumes step 1 (`get-task-details`).
- No change needed to the runner injection (`src/prompts/memories.ts`) or to `memory-search`/`memory-get`/`memory_rate` tool descriptions themselves — those are the actual mechanism, not instructional text.
