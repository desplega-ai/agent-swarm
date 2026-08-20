---
date: 2026-08-20
topic: System prompt slimdown, answers to the 21 review comments on 03-claude-worker-full.md
status: proposal, waiting for Taras
inputs:
  - thoughts/taras/research/2026-08-20-system-prompt-variants.md
  - work/prompt-variants/ (rendered variants, blocks, skills)
---

<!-- review-line-start(52de566a) -->
# System prompt slimdown proposal
<!-- review-line-end(52de566a): on a more general note, as we align with the proposal think of it as a first iteration.

Then please do some bg research and deep thinking on what would be the best approach as a whole based on this convo.

Essentially, I want the promting to be:

- Clear
- Use skills
- Focus on determinstic paths (create reusable scripts, wfs, schedules)
- Use UI components like pages or apps
- Use correct and direct humanlike lang (see comms skill we have locally)

you know? -->

Goal you stated in the comments: the prompt should carry the swarm contract, not reference material. Reference material goes to skills. Code-specific guidance becomes opt-in. Deprecated surfaces (PM2 services, artifacts) go away.

Numbers today (code defaults, minimal Claude worker): **6.4k tokens** before identity files. Target after this proposal: **about 1.6k static + volatile tail**. Worker prompt shrinks by ~70%.

## 1. Answers to the questions in the comments

| Comment | Answer |
|---|---|
<!-- review-line-start(c723281a) -->
| "join-swarm ... this is done auto now, no?" (line 9) | Yes for every runner-spawned session. `runner.ts:4888` calls `registerAgent()` (POST `/api/agents`) before the first session. The line only helps an interactive session that loads the MCP by hand, and the SessionStart hook already nudges those. Drop it from the composites. |
<!-- review-line-end(c723281a): ok lets drop -->
<!-- review-line-start(d8bb7d70) -->
| "Your Identity, should this be moved to the end?" (line 396) | I recommend the **top**, not the end. Two reasons. (1) Persona should frame the rules that follow. (2) Prompt caching: Claude Code caches the system prompt prefix. Static content (role, identity, contract) must come first and volatile content (repo context, skills list, MCP servers) last. Today repo context sits before CLAUDE.md and TOOLS.md, which breaks the cache on every repo switch. Proposed order is in section 2. |
<!-- review-line-end(d8bb7d70): ok -->
<!-- review-line-start(b152b312) -->
| "# Example Repo, what is this?" (line 430) | A fixture from my dump script: a sample repo `CLAUDE.md` so the `## Repository Context` branch renders. In production it is the CLAUDE.md of the cloned `task.vcsRepo`, capped at 12k chars. |
<!-- review-line-end(b152b312): is this something we do? I think we could just reference it instead? Wdyt? -->
<!-- review-line-start(c7aaeb92) -->
| "## Agent Instructions ?" (line 461) | The agent's own `/workspace/CLAUDE.md` (DB column `claudeMd`, synced by the PostToolUse/Stop hooks). Default body comes from `generateDefaultClaudeMd()` in `src/prompts/defaults.ts`. The sample in the render is a 3-line fixture. Proposal: keep the injection, rename the heading to `## Your notes (CLAUDE.md)` so it is clear it is agent-authored. |
<!-- review-line-end(c7aaeb92): redundant? -->
<!-- review-line-start(207d3d9e) -->
| "Capabilities enabled for this agent: redundant?" (line 606) | Yes. It prints the agent's routing tags (`artifacts`, `pages`, ...). IDENTITY.md already lists them under Expertise when set. Remove the block. |
<!-- review-line-end(207d3d9e): remove yes -->
<!-- review-line-start(fa0b2b5f) -->
| "Slack Tools, skill?" (line 366) | Tool descriptions already live in the MCP schemas, so that part is pure duplication. The two rules that matter (thread provenance, register unknown users) are behavioral and get violated, so I would keep them as 3 lines and move the rest to a `slack-interaction` skill. |
<!-- review-line-end(fa0b2b5f): yes pls -->

## 2. Proposed prompt structure

Ordered static → volatile. Same order for every provider, blocks drop by trait.

```
A. Role line (fixed typo) + Identity (name, description, SOUL.md, IDENTITY.md)   [static per agent]
B. Swarm contract (worker or lead)                                                [static]
   worker: how tasks arrive, store-progress at milestones, completed/failed semantics,
           outputSchema rule, escalation via /swarm-chat
   lead:   coordinator-not-worker rule, delegation, follow-up rule, user registration
C. Workspace and memory (rewritten, short)                                        [static]
D. Outputs: pages, apps, agent-fs (3 lines)                                       [static]
E. Communication style (kept, trimmed)                                            [static]
F. Secret hygiene (3 lines)                                                       [static]
G. Conditional contracts: Slack provenance, steering, messaging (1-3 lines each)  [static per deploy]
H. Installed skills (count for claude/pi, list for codex/opencode)                [semi-static]
I. Installed MCP servers                                                          [semi-static]
J. Your notes (CLAUDE.md), TOOLS.md                                              [per agent, edited rarely]
K. Repository context + guidelines (per task)                                     [volatile]
L. Requester profile (per task)                                                   [volatile]
```

Everything else becomes a skill or is deleted.

## 3. Block-by-block disposition

| Block today | Tokens | Comment | Proposal |
|---|---:|---|---|
| `system.agent.role` | 64 | | Keep. Fix "unique identified". |
| `system.agent.register` | 23 | auto now | **Delete** from composites. |
| `system.agent.worker` (tools list + completion + credential hygiene) | 411 | simplify; credential hygiene → skill? | **Shrink** to the contract (B). Tool list goes (MCP schemas cover it). Credential hygiene → 3 lines in (F) + move the bash examples to a `secrets-hygiene` skill. |
| `system.agent.lead` | 1017 | | **Shrink** to (B) lead contract (~300). Heartbeat runbook → `heartbeat-runbook` skill (the checklist task already carries the instructions). Task-routing "decision guide" with `/desplega:*` names → fix names or drop (see section 5). |
| `system.agent.filesystem` | 1198 | rethink, agent-fs is native now | **Rewrite** as (C), ~250 tokens. Keep: personal vs shared dir, write-only-to-your-own-dir rule, start-up.sh pointer, TOOLS.md pointer. Move: thoughts directory conventions → `researching`/`planning` skills already describe them; agent-fs details → the installed `agent-fs` skill. Drop: todos.md (deprecated). |
| `system.agent.filesystem` § Memory | (part of above) | rethink | **Rewrite**: one paragraph. "Relevant memories are injected at task start. Write new learnings to `/workspace/personal/memory/` or `/workspace/shared/memory/<id>/`; they are indexed automatically. `memory-search` for anything older." Drop the REQUIRED-at-every-task recall (the runner injects it, and `work-on-task` says it again). |
| `system.agent.self_awareness` | 343 | rethink | **Move** to a `swarm-internals` skill (provider-neutral rewrite). Prompt keeps one line: "You run inside agent-swarm (github.com/desplega-ai/agent-swarm). To propose changes to your own infrastructure, open a PR or ask the lead." |
| `system.agent.script_authoring_contract` | 1030 | script skill | **Move** into `swarm-scripts` skill. |
| `system.agent.script_rubric` | 666 (own text) | redundant with skill | **Move** the rubric table into `swarm-scripts`. Prompt keeps one line in (B): "For 10+ repetitive SDK calls or heavy data, use the `swarm-scripts` skill." |
| `system.agent.context_mode` (ctx_* paragraph) | 120 | | Keep one sentence, claude/codex/opencode only. |
| `system.agent.scheduling` | 215 | should be a skill | **Move** to a new `scheduling` skill (targetType rules + `script-workflows` content can merge here). |
| `system.agent.seed_scripts` | 355 | reduce | **Shrink** to two lines inside the `swarm-scripts` pointer: `task-context-gathering` and `script-search`. Seed catalog stays in the skill. |
| `system.agent.seed_scripts` § Exposing scripts as APIs | (part) | script skill | **Move** to `swarm-scripts`. |
| `system.agent.system` § packages | 120 | | Keep 2 lines (non-root worker, ask for new packages). |
| `system.agent.system` § VCS CLI tools | 300 | redundant, vcs skill | **Move** to a new `vcs-cli` skill (gh vs glab table, review-reply provenance rule). Prompt keeps nothing; the repo-context block says "see the `vcs-cli` skill" when a repo is attached. |
| `system.agent.share_urls` | 368 | | **Move** into `pages` skill (already has the same table). Prompt (D) keeps: "Never hardcode hosts, read `APP_URL` / `MCP_BASE_URL`." |
| `system.agent.code_quality` | 249 | skill, opt-in, less code-specific | **Move** to a `code-quality` skill with `systemDefault: false`. The MANDATORY repo guidelines block (K) stays, since it is data the operator configured, not generic guidance. |
| `system.agent.communication_style` | 327 | | Keep. Trim to ~200. |
| `system.agent.slack` | 282 | skill? | **Shrink** to 3 lines in (G); rest → `slack-interaction` skill. |
| `system.agent.worker.slack` | 114 | | Keep, it is already 2 sentences. Merge wording with the lead version so the provenance rule exists once. |
| `system.agent.messaging` | 61 | | Keep (gated, rarely on). |
| `system.agent.steering` | 80 | | Keep (gated). |
| `## Your Identity` | varies | move? | Keep, **move to the top** (A). |
| `## Installed Skills` / `## Installed MCP Servers` | varies | | Keep, after the static blocks (H, I). |
| `## Repository Context` | varies | | Keep, move to the end (K). |
| `## Agent Instructions` / `## Your Tools & Capabilities` | varies | ? | Keep, rename heading, place before repo context (J). |
| `system.agent.agent_fs` | 814 | skill, maybe with a section | **Shrink** to 3 lines in (C)/(D): "agent-fs is the home for thoughts, research, plans, and shared docs. Personal drive by default, `--org $AGENT_FS_SHARED_ORG_ID` for the shared drive, `thoughts/<agentId>/<type>/YYYY-MM-DD-name.md`. The `agent-fs` skill has the CLI." |
| `system.agent.services` | 369 | remove PM2, deprecated | **Delete** block and the legacy fallback. Port-3000 service registry stays reachable through the MCP tools for anyone who enables the capability. |
| `system.agent.artifacts` | 126 | artifacts out | **Delete**. (D) names pages and apps. `artifacts` skill flips to `systemDefault: false`. |
| `system.agent.apps` | 87 | | **Merge** into (D). |
| `### Capabilities enabled for this agent` | varies | redundant | **Delete**. |
| `system.agent.scripts_only_mode(.slack)` | 597 | | Out of scope for this pass. Experimental mode. |
| `system.agent.worker.remote` | 190 | | Keep. Align wording with (B). |

## 4. Skills to create or change

| Skill | Action | systemDefault | Content source |
|---|---|:-:|---|
| `swarm-scripts` | extend | true | + script authoring contract, rubric table, seed catalog, script APIs section |
| `scheduling` | new | true | `system.agent.scheduling` + merge `script-workflows` (or keep both and cross-link) |
| `vcs-cli` | new | true | `system.agent.system` § VCS + review-reply provenance |
<!-- review-line-start(7430dde8) -->
| `code-quality` | new | **false** | `system.agent.code_quality` |
<!-- review-line-end(7430dde8): default true -->
| `slack-interaction` | new | true | `system.agent.slack` tool list + user registration + standing orders |
| `secrets-hygiene` | new | true | credential hygiene examples |
| `swarm-internals` | new | true | `system.agent.self_awareness`, rewritten provider-neutral |
| `heartbeat-runbook` | new | true (lead only in practice) | `system.agent.lead` § Heartbeat Checklist |
| `pages` | extend | true | + share URLs table (already there, dedupe) |
| `artifacts` | flag | **false** | unchanged |
<!-- review-line-start(2852282b) -->
| `workflow-structured-output` | delete or flag false | - | the turn prompt already carries the outputSchema contract |
<!-- review-line-end(2852282b): we could still keep these, or you think redundant? -->
| `download-task-attachment` | delete or flag false | - | the turn prompt already carries the curl recipe |

Skills with `systemDefault: false` are seeded into the DB and toggled per agent in the UI.

## 5. Decisions I need from you

1. <!-- review-line-start(fd66bc34) -->
**`/desplega:*` command names.** The lead decision guide, `system.agent.filesystem`, `work-on-task`, `start-leader`, `implement-issue`, and `one-shot` reference `/desplega:research`, `/desplega:create-plan`, `/desplega:implement-plan`. The worker image has no desplega plugin; seeded skills are `/researching`, `/planning`, `/implementing`. Options: (a) rename references to the seeded skill names, (b) install the plugin in the image, (c) drop the routing guide and let the lead pick skills by description. I recommend (a) now and (c) as the direction.
<!-- review-line-end(fd66bc34): we should change this, as it’s old, and now those are bundled -->
2. <!-- review-line-start(a938a217) -->
**Memory direction.** The rewrite in section 3 assumes the runner-injected "Relevant Past Knowledge" is the primary recall path and explicit `memory-search` is secondary. The profile-to-memory research (PR #1035) decided hybrid prompt/recall. Confirm that is still the plan.
<!-- review-line-end(a938a217): lets align on this -->
3. <!-- review-line-start(7f13d7b3) -->
**Workspace block.** Should the prompt still teach `/workspace/shared/thoughts/<id>/...` at all, or is agent-fs the only documented home for thoughts now? Section 3 keeps the local dirs for repos, downloads, misc, and moves thoughts to agent-fs.
<!-- review-line-end(7f13d7b3): do research on how fs is supported in the swarm and let’s stick to the new way pls -->
4. <!-- review-line-start(010e32ec) -->
**Lead heartbeat text.** Move to a skill (proposal) or keep a 5-line version in the lead contract? The `heartbeat.checklist` task already carries 8 numbered instructions, so the system prompt copy is the third place this lives.
<!-- review-line-end(010e32ec): skill -->
5. <!-- review-line-start(28a46f25) -->
**Identity at the top.** Confirm top (my recommendation) vs end (your question).
<!-- review-line-end(28a46f25): could we even “reduce it” or think of other ways? do you think it’s the best approach to always have all odf those there? -->
6. <!-- review-line-start(dab11860) -->
**Scope of this pass.** Prompt templates + new skills only. No provider/runner changes except the block order in `base-prompt.ts` and deleting the services/artifacts/capabilities branches. scripts-only mode untouched.
<!-- review-line-end(dab11860): yes -->

## 6. Execution order (after approval)

1. Create/extend the skills in `templates/skills/` (content.md + config.json), register in `BUILT_IN_SKILL_SOURCES`, run `bun run check:skill-sources && bun run check:skill-md && bun run check:seed-skill-files`.
2. Rewrite `session-templates.ts` blocks and composites. Delete dead blocks.
3. Reorder `base-prompt.ts` (identity first, repo context last), delete services/artifacts/capabilities branches.
4. Update `plugin/commands/work-on-task.md`, `start-leader.md`, `start-worker.md`, `implement-issue.md` for the command-name decision, then `bun run build:pi-skills`.
5. Update tests: `src/tests/base-prompt.test.ts`, `prompt-template-session.test.ts`, `scripts-only-gating.test.ts`, `capability-surface` tests.
6. Re-run `bun scripts/dump-prompt-variants.ts` and diff token counts per variant against today's index.
7. Docs: `runbooks/skills.md` list, `docs-site` prompt/skills pages if they enumerate blocks.

### Verification

```bash
bun run tsc:check
bun run test:root -- src/tests/base-prompt.test.ts src/tests/prompt-template-session.test.ts src/tests/scripts-only-gating.test.ts
bun run check:skill-sources && bun run check:skill-md && bun run check:seed-skill-files
bun scripts/dump-prompt-variants.ts /tmp/after && diff <(grep '^| 0' work/prompt-variants/00-INDEX.md) <(grep '^| 0' /tmp/after/00-INDEX.md)
```

### Manual E2E

```bash
# fresh DB so seeds apply
rm agent-swarm-db.sqlite && bun run start:http
# worker container picks up new skills + prompt
bun run docker:build:worker && bun run pm2-restart
# send a task, then inspect the system prompt the worker actually sent
curl -s -H "Authorization: Bearer $AGENT_SWARM_API_KEY" $MCP_BASE_URL/api/tasks -d '{"task":"Say hi and complete"}' -H 'Content-Type: application/json'
ls /workspace/logs/*.jsonl   # in the worker container; first line carries the prompt metadata
# skills present on disk
docker exec <worker> ls ~/.claude/skills | grep -E 'swarm-scripts|scheduling|vcs-cli|code-quality|slack-interaction'
```
