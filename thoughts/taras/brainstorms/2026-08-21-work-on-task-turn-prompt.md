---
date: 2026-08-21T16:40:00+02:00
author: Taras
topic: "work-on-task turn prompt rewrite, aligned with system prompt v2"
tags: [brainstorm, prompts, work-on-task, system-prompt-v2, defer-task]
status: complete
exploration_type: workflow
last_updated: 2026-08-21
last_updated_by: Claude
---

# work-on-task turn prompt rewrite — Brainstorm

## Context

`plugin/commands/work-on-task.md` is the turn prompt for every assigned task. The runner renders `task.trigger.assigned` as `/work-on-task <taskId>` + `Task: "<description>"` + an attachments block + output instructions, then appends relevant memories (`src/commands/runner.ts`, `src/commands/templates.ts`). Claude expands the slash command natively; codex inlines the skill body (`src/providers/codex-skill-resolver.ts`); pi and opencode load `plugin/pi-skills/`, built from `plugin/commands/*.md` by `bun run build:pi-skills`.

The file predates system prompt v2 (PR #1217) and the `defer-task` tool (PR #1235). It still says:

1. `get-task-details` first (the task text is already in the turn prompt).
2. `memory-search` before any work (recall is injected into the turn prompt; `task-context-gathering` exists as a script for an explicit one-call recall).
3. Research → `/researching`, development → `/planning` then `/implementing`, simple → direct (no script / schedule / page-or-app branch).
4. `store-progress` at milestones.
5. Completion: `completed` or `failed` only (no `defer-task`, no `request-human-input`).
6. "If no taskId, call `poll-task`" (poll-task is low-key deprecated: task assignment happens at the code level, the runner receives the task and opens the turn).
7. "When to escalate": `/swarm-chat` to ask the lead (swarm messaging is deprecated per the v2 design).

The design doc for v2 (`thoughts/taras/plans/2026-08-20-system-prompt-v2-design.md`, section 8) deferred this file. Taras (2026-08-21): full rewrite, brainstorm it first.

Related: the v2 worker block in `src/prompts/session-templates.ts` already carries the branch rule (script / schedule / page-or-app / direct), the milestone rule, and the four endings. The turn prompt and the system prompt overlap today; the question is what each should own.

## Exploration

### Q: What kind of exploration is this?
Workflow to improve.

**Insights:** The turn prompt is a per-task workflow; the real question is what it owns versus the v2 system prompt.

### Q: What should the turn prompt own relative to the system prompt?
Slim. The system prompt got the work; the turn prompt should not restate it.

**Insights:** Rules out the full-checklist draft. The branch rule, milestone rule, and the four endings stay system-prompt only. The turn prompt keeps only what is specific to starting this task. Drift risk drops to near zero because nothing is duplicated.

### Q: Should the turn prompt still tell the agent to gather context?
Fallback only. The task, attachments recipe, outputSchema, and memories are already in the turn message.

**Insights:** Fact (src/commands/runner.ts): the trigger prompt is `/work-on-task <id>` + `Task: "..."` + attachments recipe + output instructions, then `fetchRelevantMemories` appends recall. So `get-task-details` and `memory-search` as opening steps are redundant. The only cases without the context in the message are a manual `/work-on-task <id>` (after an interruption) and a post-compaction resume. One sentence pointing at the `task-context-gathering` script covers both.

### Q: `/work-on-task` with no taskId (today: "call poll-task")?
Look up your own assigned task with `get-tasks`; if none, stop and say so. No poll-task mention anywhere.

**Insights:** poll-task is deprecated: assignment happens at the code level and the runner opens the turn. `start-worker.md` still documents poll-task as the worker loop (step 2); that file is outside this rewrite but carries the same stale instruction.

### Q: What should the ending say?
One-line pointer that names the four endings (completed, defer-task, request-human-input, failed) and says "then stop". No "reply DONE".

**Insights:** Fact: nothing in `src/commands/runner.ts` or the providers keys on the literal DONE; only `review-offered-task.md` repeats the ritual. Naming the four endings in one line is the one deliberate overlap with the system prompt, because the evals showed the ending is what agents get wrong.

### Q: Where should the /researching, /planning, /implementing routing live?
The lead names the command in the task text. The turn prompt keeps one fallback line: when the task names a command, use it; otherwise work directly.

**Insights:** Fact: only the lead block names these commands (`src/prompts/session-templates.ts:96`); the v2 worker block does not. A type-based routing table in the turn prompt would second-guess the lead.

### Q: Scope beyond work-on-task.md?
Fix the stale lines only: the poll-task loop in `start-worker.md` and "reply DONE" in `review-offered-task.md`. No rewrite of either; `/todos` and `swarm-chat` cleanup stays a separate item.

**Insights:** Fact: `/start-worker` is the `defaultPrompt` of `agent-swarm worker` (`src/commands/worker.ts`), but the runner only sends it for trigger types that have no template of their own; every assigned task opens with `/work-on-task` (`buildPromptForTrigger`, `src/commands/runner.ts`). The runner polls over HTTP, not with the MCP `poll-task` tool. So the poll-forever loop in `start-worker.md` only ever ran in a human-driven Claude Code session, the flow poll-task's deprecation retires.

### Review round (file-review, 2026-08-21)

**Q: Migrate work-on-task to a skill instead of a command?** Yes, inside PR #1235, for the two runner-sent turn prompts (work-on-task, review-offered-task). The other 11 commands stay for the later plugin/commands deprecation phase.

**Insights:** Fact found while checking: opencode workers never receive the work-on-task body today. `plugin/commands/*.md` are baked into `~/.claude/commands`, `~/.codex/skills/<name>/SKILL.md` (Dockerfile conversion loop), and `plugin/pi-skills/`; the opencode resolver reads `~/.opencode/skills`, which mirrors `~/.claude/skills`, not commands. Eval worker logs (run-202608210002-17ff83, opencode #0): "[opencode] skill resolver: SKILL.md not found for /work-on-task". A seeded skill (`templates/skills/<name>/`) is written to all four trees by `src/utils/skill-fs-writer.ts` and the entrypoint sync. Rule to respect: one skill name must not be both seeded and baked, so the baked copies go. `claude-managed-setup.ts` uploads `plugin/commands/*.md` as managed skills; it must also upload the two seeded skills or managed agents lose the turn prompts.

**Q: "Skill instead of command" for researching / planning / implementing?** Skill wording everywhere. They are seeded skills (synced from ai-toolbox). The lead block now says "the `researching` skill" (commit cc46bc3d); work-on-task says "When the task names a skill (`researching`, `planning`, `implementing`), use it."

**Q: What about pi and opencode?** Previews added below. pi: the runner sends `/skill:work-on-task <id>` (`pi-mono-adapter.formatCommand`); pi loads `~/.pi/agent/skills/work-on-task/SKILL.md` natively. opencode: `/work-on-task <id>`, inlined by the same resolver codex uses, from `~/.opencode/skills` (which is why the seeded skill fixes it).

**Q: Add the requester id (people table)?** Done (commit cc46bc3d): the poll trigger's `requestedBy` carries `users.id`, and the turn line reads `Requested by: Taras (t@desplega.ai, user <id>)`.

**Q: Full memory ids for clear retrieval?** Already the case: `src/prompts/memories.ts` renders `(id: <full id>)`. The first preview truncated them for brevity; fixed below.

**Q: Codex should work with `$<skill>`?** Codex CLI can reference skills with `$name` mentions, but our adapter does not rely on it: `formatCommand` emits `/work-on-task` and `codex-skill-resolver.ts` inlines `~/.codex/skills/work-on-task/SKILL.md` into the turn before it reaches `thread.runStreamed()`. Inlining is deterministic (no dependence on the model choosing to open the skill) and is shared with opencode. Leaving it.

**defer-task feedback (same session):** "it should have a completion note, and not sure if status too?" → `defer-task` gains a required `summary` (what was done so far); the task still ends `completed` (no new status); the tool description and the worker block say plainly that the call puts the task in its final state.

## Synthesis

### Key Decisions
- The turn prompt is slim. It owns only what is specific to starting this task; the v2 worker block owns the branch rule, the milestone rule, and the endings.
- Opening: no `get-task-details`, no `memory-search`. The task, attachments recipe, outputSchema, and memories are in the turn message. One fallback sentence points at the `task-context-gathering` script (manual `/work-on-task <id>`, post-compaction resume).
- No taskId: `get-tasks` for your own pending or in_progress task; none → stop and say so. `poll-task` is not mentioned anywhere.
- Commands: when the task names `/researching`, `/planning`, or `/implementing`, use it; otherwise work directly. No type-based routing table; the lead names the command.
- Ending: one line that names the four endings (`completed`, `defer-task`, `request-human-input`, `failed`) and says "then stop". The one deliberate overlap with the system prompt. No "reply DONE".
- Escalation section dropped (`/swarm-chat` is deprecated; the endings cover "stuck": `request-human-input` or `failed`).
- Deferred: the interruptions line. Defaulting to keep one sentence ("If the user interrupts, follow them. To resume, call `/work-on-task <taskId>`.") because a resume needs the command name.
- Deferred: the fan-out wait rule for workers that `send-task`. Defaulting to leave it out of the turn prompt; the lead block carries it and worker fan-out is rare. Revisit if evals show workers ending turns with children running.
- Deferred: milestones (`store-progress`). Defaulting to no mention; the worker block carries it.
- work-on-task and review-offered-task become seeded skills (`templates/skills/`, `systemDefault: true`), baked copies removed; fixes the opencode gap. Shipped in PR #1235.
- Skill wording for researching / planning / implementing in the lead block and in work-on-task.
- Requester id in the task turn; memory ids already full.
- `defer-task`: required `summary`, final state stays `completed`, description says so.
- Scope: same PR also drops the poll-task loop from `start-worker.md` (workflow becomes: check your own tasks with `get-tasks`, resume any in-progress one with `/work-on-task`; otherwise the runner assigns and opens the turn) and "reply DONE" from `review-offered-task.md`. No further rewrite of those files.

### Open Questions
- None fact-shaped. The runner facts above were checked during the session.

### Constraints Identified
- `plugin/commands/*.md` feed three delivery paths: Claude slash command, codex skill inlining (`codex-skill-resolver.ts`), and `plugin/pi-skills/` (regenerated by `bun run build:pi-skills`, CI-checked). The text must read correctly when inlined with no slash-command context.
- `work-on-task.md` must not contradict `system.agent.worker` in `src/prompts/session-templates.ts`; the only restated item is the list of four endings.
- `hasMcp=false` providers never receive `/work-on-task` (remote composite), so the file can assume MCP tools exist.

### Core Requirements
- Rewrite `plugin/commands/work-on-task.md` to: argument handling (taskId or own-task lookup), the context fallback sentence, the command line, one line on working ("work the task; the lead reads `store-progress`"), the ending line, the interruptions line. Target: under 20 lines of body.
- Update `start-worker.md` Tools/Workflow (remove poll-task, the poll-forever loop) and `review-offered-task.md` (remove DONE).
- `bun run build:pi-skills`, commit `plugin/pi-skills/`.
- Migrate work-on-task and review-offered-task to `templates/skills/` (config.json + content.md, `BUILT_IN_SKILL_SOURCES`), delete the `plugin/commands` files and their pi-skills, extend `claude-managed-setup.ts` to upload the seeded pair.
- `defer-task`: required `summary`; description + worker block say the task reaches its final state.
- Ship in PR #1235 (stacked on #1217).

## Preview

### The new `plugin/commands/work-on-task.md` (body)

```markdown
# Working on a task

The taskId follows the command. Without one, call `get-tasks` with `mineOnly: true` and take your `pending` or `in_progress` task. If there is none, say so and stop.

This message carries the task text, its attachments, its output format, and memories from past sessions. If it does not (you invoked this command yourself, or the context was compacted), run the `task-context-gathering` script with the taskId.

When the task names a skill (`researching`, `planning`, `implementing`), use it. Otherwise work directly.

Finish the task with one of the four endings in your operating contract: `completed`, `defer-task`, `request-human-input`, or `failed`. Then stop.

If the user interrupts, follow their instructions. To resume, call `/work-on-task <taskId>` again.
```

11 lines of body (was 39). For comparison, the four endings in `system.agent.worker` read: "The task has four endings. When you are done: `completed`. When the answer needs time (a build, a deploy, a reply): `defer-task` with when and what to check. When a person must decide: `request-human-input`. When nothing else is possible: `failed` with the blocker."

### What the worker receives on a task turn (Claude, slash command expanded natively)

The runner sends this as the user turn (`task.trigger.assigned` + `fetchRelevantMemories`, `src/commands/runner.ts`):

```text
/work-on-task 7f3c2a10-5b1e-4d8a-9c0e-2a6f1b3d4e55

Task: "Use the implementing skill on thoughts/taras/plans/2026-08-20-rate-limit-headers.md. Repo: https://github.com/desplega-ai/agent-swarm. Open a PR against main; do not merge."

Requested by: Taras (t@desplega.ai, user 4d1c9b2e-7a3f-4e0b-9c8d-5f6a7b8c9d0e)

📎 Attachment(s) — fetch directly, no need to discover the storage path yourself:
- rate-limit-spec.md (4812 bytes): `curl -s -H "Authorization: Bearer ${AGENT_SWARM_API_KEY:-$API_KEY}" -H "X-Agent-ID: $AGENT_ID" "$MCP_BASE_URL/api/fs/tasks/7f3c2a10-5b1e-4d8a-9c0e-2a6f1b3d4e55/files/a91b.../raw" -o /tmp/rate-limit-spec.md`

When done, use `store-progress` with status: "completed" and include your output.

### Relevant Past Knowledge

These memories from your previous sessions may be useful. Use `memory-get` with the memory ID to retrieve full details.

- [mem_01…] CI on this repo runs `bun run lint` read-only; `lint:fix` locally before pushing.
- [mem_02…] PRs touching src/http need `bun run docs:openapi` and a committed openapi.json.
```

Claude expands `/work-on-task` into the 11-line body above; the task text, attachments, output instruction, and memories follow. The agent reads the task, sees the `implementing` skill named, and starts the plan. Note the existing `output_instructions` line ("When done, use `store-progress`…") stays as is; it comes from the trigger template, not from this file.

### The same turn for codex (skill inlined by `codex-skill-resolver.ts`)

```text
# Working on a task

The taskId follows the command. Without one, call `get-tasks` …
[… the 11-line body …]

---

User request: 7f3c2a10-5b1e-4d8a-9c0e-2a6f1b3d4e55

Task: "Use the implementing skill on thoughts/taras/plans/…"
[… same attachments, output instruction, memories …]
```

This is why the body says "the taskId follows the command" rather than using `$ARGUMENTS`: codex and pi receive the arguments as trailing text, not as a substituted variable.

### The same turn for pi

```text
/skill:work-on-task 7f3c2a10-5b1e-4d8a-9c0e-2a6f1b3d4e55

Task: "Use the implementing skill on thoughts/taras/plans/…"
[… same attachments, output instruction, memories …]
```

`pi-mono-adapter.formatCommand` emits `/skill:<name>`; pi loads `~/.pi/agent/skills/work-on-task/SKILL.md` itself (today from `plugin/pi-skills/`, after the migration from the seeded skill).

### The same turn for opencode

```text
/work-on-task 7f3c2a10-5b1e-4d8a-9c0e-2a6f1b3d4e55
[… same task, attachments, output instruction, memories …]
```

The opencode adapter runs the same resolver as codex against `~/.opencode/skills`. Today that lookup fails ("SKILL.md not found for /work-on-task") and the worker sees only the raw line plus the task text; after the migration the seeded skill is present and the body is inlined exactly as for codex.

### A manual invocation with no id (interactive session)

```text
/work-on-task
```

→ the agent calls `get-tasks { mineOnly: true }`, picks its `in_progress` task, and, since this message carries no task text, runs `task-context-gathering { taskId, queries: [...] }` before working.

## Next Steps

- Implement directly in PR #1235 (the synthesis is the plan; three small markdown files).
