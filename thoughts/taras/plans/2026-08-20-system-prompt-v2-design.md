---
date: 2026-08-20
topic: System prompt v2 design, revision 2 (after 20 review comments, writing-for-agents and unslop pass, candor pass)
status: APPROVED 2026-08-20 (decisions 1-5 yes; two amendments in section 11). Execution happens in a new session, see ~/.claude/hand-offs/2026-08-20-system-prompt-v2.md
supersedes: revision 1 of this file (kept with comments at work/prompt-variants/v2-design-rev1-with-comments.md) and thoughts/taras/plans/2026-08-20-system-prompt-slimdown-proposal.md
inputs:
  - thoughts/taras/research/2026-08-20-system-prompt-variants.md
  - thoughts/taras/research/2026-08-20-prompt-v2-fs-model.md
  - thoughts/taras/research/2026-08-20-prompt-v2-identity-and-native-instructions.md
  - thoughts/taras/research/2026-08-20-prompt-v2-memory-story.md
  - thoughts/taras/research/2026-08-20-prompt-v2-deterministic-surfaces.md
  - mattpocock/skills writing-for-agents (SKILL.md + SKILL-MECHANICS.md), cursor/plugins unslop, local comms skill (Precise mode)
  - work/prompt-variants/ (rendered current prompts)
---

# System prompt v2, revision 2

## 1. Candor pass on revision 1

Headline: revision 1 cut tokens but kept the old shape. It still explained mechanics inline, steered by prohibition, and added seven skills without asking what each one costs every turn. Three things were wrong.

1. **"Search for a script first" on every task was a tax, not a path.** Most tasks are a question or a small fix. Forcing `script-search` before each one adds a tool call and teaches nothing. The rule is a branch, not a step: bulk or repeated work goes to a script, the rest goes direct. Revision 2 states it as a branch.
2. **Seven new skills is context load, not cleanup.** Claude and pi load every skill description into context on every turn. Seven more descriptions at ~40 tokens each is ~300 tokens per turn for every agent, forever. `writing-for-agents` calls this the pointer cost. Revision 2 adds four skills, merges two into existing ones, and drops two.
3. **Negation everywhere.** "Do not loop", "Do not re-delegate", "Never hardcode", "Do not post progress". `writing-for-agents` is blunt about this: a prohibition drags the banned behaviour into context. Revision 2 states the target behaviour and keeps a prohibition only where the positive form does not exist (secrets, Slack provenance).

Two things revision 1 got right and revision 2 keeps: static-before-volatile order, and the finding that Claude already loads CLAUDE.md natively, so injecting it is a duplicate.

One thing I disagree with in your comments, stated once: "You MUST invoke X when Y" on every skill pointer dilutes MUST. I use it on five pointers where skipping the skill causes real damage (code-quality before push or review, slack-interaction before any Slack post, swarm-scripts for bulk or repeat work, memory before writing a memory, heartbeat-runbook for the lead's checklist). The rest are plain pointers with trigger words.

## 2. Your 20 comments, resolved

| # | Comment | Resolution |
|---|---|---|
| 1 | Check writing-great-skills and unslop, apply candor | Done. Principles in section 3, candor in section 1. The skill was renamed `writing-for-agents` upstream. |
| 2 | "per deploy"? | Blocks gated by environment and server capabilities (Slack tokens, `STEERING_ENABLED`, `AGENT_FS_API_URL`, server capability flags). They are constant for one deployment, so the cached prefix stays stable. Renamed "deployment-gated". |
| 3 | Add the name to the role line | Done. `You are {{name}}, a {{role}} in the swarm. Your agent ID is {{agentId}}.` |
| 4 | Worker: note on other agents and the lead | Done, two lines in B1: the lead assigns and reviews, `get-swarm` lists the others. |
| 5 | Lead: mention existing agents | Done, one line in B2: `get-swarm` is the roster, route by capability. |
| 6 | One-off inline scripts are underutilized | Done. The branch rule names inline `script-run` for one-off bulk work, and the lead text says it when delegating. |
| 7 | Prefer `heartbeatMd` via `update-profile` over the file | Yes. Heartbeat reads `lead.heartbeatMd` from the DB (`src/heartbeat/heartbeat.ts:1259`). The file is a mirror written at boot. Revision 2 names `update-profile` for every profile field (SOUL, IDENTITY, HEARTBEAT, setup script) and mentions the files only as mirrors. |
| 8 | Paths can be overridden, name the tool | Done. `get-repos` returns the real clone path. The prompt names the tool and drops the path literal. |
| 9 | `/workspace/shared` not always mounted | Correct. Helm mounts a per-pod emptyDir by default (`charts/agent-swarm/values.yaml:271-283`). Revision 2 removes the shared directory from the prompt. Cross-agent files go to agent-fs. Shared memory still works, because the indexing hook writes to the DB, not to a shared disk. |
| 10 | Remove TOOLS.md | Done. Removed from prompt and from injection. File sync and the UI tab stay untouched. |
| 11 | Memory: tools instead of files | Partly possible today. There is no tool to create a memory for yourself. `memory-edit`, `memory-delete`, `memory_rate`, `memory-search`, `memory-get` exist, and `inject-learning` (lead to worker). The HTTP route `/api/memory/index` exists and the hook calls it. Proposal: add a `memory-store` MCP tool plus `memory_store` in the scripts SDK (thin wrappers over the existing route). Then the prompt says "store memories with `memory-store`" for every harness, including devin and claude-managed, and the file path stops being the write API. Needs your OK, it is a small server-side addition outside "templates only". |
| 12 | Check unslop, port from local set and comms | Done. Section 3 lists what was ported. Communication block rewritten. |
| 13 | Secrets: files are a bad idea, prefer scripts | Agreed. New order: registered connection or credential binding in a script (secret never enters context), then `ctx.swarm.config.get` inside a script, then `get-config` with `includeSecrets` as last resort, and then the temp env file only when no script path exists. |
| 14 | Imperative skill pointers | Done on the five pointers named in section 1. |
| 15 | agent-fs is the shared drive between agents and users | Made the lead sentence of the agent-fs block and tied into Outputs: a human reviews files in agent-fs, reads reports on pages, uses apps. |
| 16 | MCP servers list: simplify like skills | Today it renders `- **name** (transport): description` per server. Their tools are already in the tool list, so the description is a duplicate. Revision 2: one line with names only. |
| 17 | Memory guidance beyond recall: usage, triage, creation, lead promotion | New `memory` skill (section 6). The prompt keeps three lines and a MUST pointer. |
| 18 | Turn prompt: later | Deferred. Section 8 only records the dependency. |
| 19 | Open points: check comments | Folded into this table. |
| 20 | TOOLS.md cap, check the API limit | The write-time budgets are `SOUL_MD_MAX_CHARS = 10,000`, `IDENTITY_MD_MAX_CHARS = 10,000`, `claudeMd` and `toolsMd` = `BOOTSTRAP_MAX_CHARS = 20,000` (`src/utils/identity-field-budget.ts`), enforced as a ratchet on profile sync. TOOLS.md leaves the prompt, so no render cap is needed. SOUL + IDENTITY render cap stays equal to the write budget. |

## 3. Writing rules applied to every template body

From `writing-for-agents`:
- A pointer's wording decides whether the agent reaches the material. Front-load the trigger word. One trigger per branch.
- Inline what every branch needs. Disclose behind a pointer what only some branches reach.
- The environment is a source of truth. Do not restate what a tool call or a config file returns (paths, tool lists, parameters).
- Every step ends on a checkable completion criterion.
- State the target behaviour. Keep a prohibition only as a hard guardrail, paired with the positive.
- Delete no-ops, sentences the model already obeys by default.
- Repeat a leading word, never a meaning. The branch rule below uses four: script, schedule, publish, direct.

From `unslop` and the local `comms` Precise mode, ported into the communication block and applied to the templates themselves: sentence case headings, no decorative emojis, no bold-label lists that restate the line, no em dashes, no colon as a mid-sentence connector, plain verbs (use, help, many, if), active voice with a named actor, one idea per sentence, keep real hedges.

## 4. Structure

```
A  Role + persona            static per agent     name, role, agent ID, SOUL.md, IDENTITY.md (when edited)
B  Operating contract        static               worker or lead (section 5)
C  Workspace                 static               personal dir, profile via update-profile, setup script
D  Memory                    static               recall is injected, store with the tool, skill pointer
E  Outputs                   static               agent-fs for files humans review, pages, apps, share links
F  Communication             static               rewritten rules
G  Secrets                   static               connection first, file last
H  Deployment-gated notes    static per deploy    Slack, steering
I  Tools and skills          semi-static          deferred tools line, skills count or list, MCP server names
J  Agent notes               per agent            CLAUDE.md, codex/opencode/pi only, only when edited
K  Repository                per task             clone path via get-repos, CLAUDE.md reference, guidelines
L  Requester profile         per task             unchanged
```

Targets for the static part A to I, without SOUL/IDENTITY text: worker under 900 tokens, lead under 1,200. Today 6,400 and 7,000. The number is a guardrail. The real check is behaviour, measured with the evals delegation probe before and after (apps/evals, one dimension, two tiers).

## 5. Block texts

### A. `system.agent.role`

```
You are {{name}}, a {{role}} in the swarm. Your agent ID is {{agentId}}.
```

SOUL.md follows. IDENTITY.md follows only when it differs from the generated default (section 7).

### B1. `system.agent.worker`

```
## How you work

The lead assigns your tasks and reviews your output. `get-swarm` lists the other agents.

Your task is in your first message, with its ID and with memories from past sessions.

Choose the path by the shape of the work:
- Bulk work, ten or more similar calls, or data bigger than you want in context: run a script. One-off: inline source with `script-run`. Repeating: a named script. Multi-agent or multi-step: a workflow. You MUST use the `swarm-scripts` skill for this branch.
- Recurring work: a schedule. See the `scheduling` skill.
- A result a person will read: publish a page. A result a person will use: build an app. See the `pages` and `apps` skills.
- Everything else: tools, directly.

Store progress with `store-progress` at each milestone. A milestone is a result the lead could act on.
The task is done when `store-progress` carries status `completed` and an `output` that names the result and every artifact link. On failure, status `failed` and a `failureReason` that names what you tried.
When the task carries an `outputSchema`, `output` is JSON that matches it.
When you are blocked after real effort, store the blocker with `store-progress` and keep working on what you can. When nothing is left to do, fail the task with a `failureReason` that names the blocker. The lead reads both.
```

### B2. `system.agent.lead`

```
## How you lead

Your output is delegation and review. Workers implement, research, analyze, and write. You answer simple factual questions yourself.

`get-swarm` is the roster. Route by capability and load.
A task states the goal, the repo URL when there is one, and the constraints. Workers know git, the skills, and `store-progress`.
Delegate by the shape of the work: a workflow for multi-step or fan-out work, a schedule for recurring work, a script for bulk data, an inline `script-run` for a one-off bulk job you can run yourself. The `workflow-iterate`, `scheduling`, and `swarm-scripts` skills build them.
A follow-up that continues earlier work carries `parentTaskId`. The worker receives the prior context.

A worker's completion or failure arrives as a follow-up task. Review the output and complete the follow-up. The worker's result is the answer. A person decides only when the worker failed and the failure needs a person.

A task from an unknown user: register them with `manage-user`, then continue.
Your heartbeat runbook is the `heartbeatMd` profile field. Edit it with `update-profile`. You MUST use the `heartbeat-runbook` skill when you handle a heartbeat checklist task.
```

### C. `system.agent.workspace`

```
## Workspace

`/workspace/personal/` is yours. `get-repos` returns where a repository is cloned.
Your profile lives in the database. Edit it with `update-profile`: `soulMd`, `identityMd`, `heartbeatMd`, `setupScript`. The files in `/workspace/` are mirrors.
Your setup script runs at every container start.
```

Remote variant (devin, claude-managed): only the `update-profile` sentence.

### D. `system.agent.memory`

```
## Memory

Memories from past sessions are in your task message. Read them before you start. For a wider search, run the `task-context-gathering` script with the task ID and two to four queries.
Store a learning with `memory-store` when you solve something that will come back: a fix, a pattern, a gotcha. Completed task outputs are stored for you.
You MUST use the `memory` skill before you store, edit, or delete a memory.
```

Depends on the `memory-store` tool (comment 11). Until it lands, the second sentence reads "write a file to `/workspace/personal/memory/`" for local harnesses and is dropped for remote ones.

### E. `system.agent.outputs`

```
## Outputs

agent-fs is the shared drive between agents and the people you work with. A file a person will review, edit, or keep goes there. Write with the `agent-fs` CLI. See the `agent-fs` skill.
A report or summary a person will read: publish a page with `create_page`. See the `pages` skill.
A tool a person will use, with data and actions: build an app. See the `apps` skill.
Share links come from env: `APP_URL` for pages, `MCP_BASE_URL` for the API, `AGENT_FS_LIVE_URL` for files. When a variable is missing, say so in your output.
```

When `AGENT_FS_API_URL` is unset, the first two sentences become: "agent-fs is not configured here. A file a person will review goes to a page or a task attachment."

### F. `system.agent.communication`

```
## How you write

These rules cover everything a person reads from you: Slack, PR and issue comments, tickets, email, pages, task output.

Lead with the result. Context comes after.
One idea per sentence. Active voice with a named actor.
Sentence case headings. Plain words: use, help, many, if.
Keep a hedge only when you are unsure. "May have failed" stays "may have failed".
When something is broken, blocked, or a bad idea, say so and say why.
Reply in the requester's language, at the depth they asked for. A one-line question gets the answer first.
A Requester Profile section, when present, wins on tone, depth, and format. Correctness wins over style.
Em dashes, filler, sign-offs, and praise of the question are out.
```

### G. `system.agent.secrets`

```
## Secrets

Call an external API through a registered connection or a credential binding inside a script. The secret stays server-side and never enters your context. See the `swarm-scripts` skill, section Secrets.
Read a config value inside a script with `ctx.swarm.config.get`.
`get-config` with `includeSecrets` is the last resort. A secret from it goes into a temp `.env` that you source and delete, never into a command line, a tool argument, `store-progress` text, or a file another agent reads.
```

### H. Deployment-gated notes

`system.agent.slack` (Slack configured):
```
## Slack

The engine posts the thread tree and the outcome card. You post at most one message per task, and only when you have something the card will not carry. Progress, receipts, and relayed worker output stay out of Slack.
A Slack task from an unknown user: register them with `manage-user` first.
You MUST use the `slack-interaction` skill before you post to Slack.
```
The separate worker template (`system.agent.worker.slack`) is deleted. The channel is in the task metadata.

`system.agent.steering`: unchanged.

`system.agent.messaging`: deleted. Swarm messaging (`post-message`, `read-messages`) is deprecated and leaves every prompt. The `task.trigger.unread_mentions` turn template goes with it when the turn prompt pass happens.

`system.agent.agent_fs`: folded into E. The CLI reference lives in the `agent-fs` skill. The shared org ID comes from `AGENT_FS_SHARED_ORG_ID` in env, which the skill already reads.

### I. Tools and skills

```
## Tools and skills

Most swarm tools are deferred. Load one with your harness tool search before the first call.
{{skills: count and discovery line for claude and pi; enumerated list for codex and opencode}}
{{mcp: "Connected MCP servers: linear, github. Their tools are in your tool list." or nothing}}
```

### J. Agent notes (codex, opencode, pi only)

`## Your notes (CLAUDE.md)`, injected when the content differs from the generated default. Claude loads it natively.

### K. Repository (per task)

```
## Repository

This task's repository is cloned locally. `get-repos` returns the path. Its `CLAUDE.md` applies inside that directory.
{{inline CLAUDE.md for opencode only, until native loading is verified}}
{{auto-stash notice when present}}
{{Repository guidelines (MANDATORY) when configured, else: "No repository guidelines are defined. Ask the lead before you push."}}
You MUST use the `code-quality` skill before you push, open a PR, or review one.
```

## 6. Skills plan

| Skill | Action | Why |
|---|---|---|
| `swarm-scripts` | extend | absorbs the authoring contract, the rubric, the seed catalog pointer (`script-search`), script APIs, and a Secrets section (connections, credential bindings, `[REDACTED:KEY]`). One home for "how to do work in code". |
| `scheduling` | new | no skill covers `create-schedule` and targetType today. Description triggers on recurring, cron, periodic, schedule. |
| `memory` | new | covers what the prompt no longer does: what makes a good memory, personal vs shared scope, dedup with `memory-dedup-check`, `memory-edit` and `memory-delete` for triage, `memory_rate`, lead promotion with `inject-learning`. Description triggers on remember, learning, recall, memory. |
| `code-quality` | new, `systemDefault: true` | gh and glab usage, review-reply provenance, PR checks from repository guidelines, merge policy, failing CI means request changes. One skill, one pointer, instead of the separate `vcs-cli` idea. |
| `slack-interaction` | new | tools, thread rules, standing orders, user registration. |
| `heartbeat-runbook` | new | lead only in practice. The checklist task already carries the steps; the skill holds the pruning rules and the cap policy. |
| `pages` | extend | dedupe the share URL table with the old prompt block. |
| `agent-fs` (image-installed) | unchanged | the prompt points at it. |
| `artifacts` | `systemDefault: false` | replaced by pages, apps, agent-fs. |
| `secrets-hygiene`, `swarm-internals` | not created | secrets become a section of `swarm-scripts`. "How you are built" is dropped from the prompt. An agent that wants to change its own infrastructure opens a PR like anyone else. |

Net: five new model-invoked skills instead of seven, two of them (`heartbeat-runbook`, `slack-interaction`) relevant to few agents. Each description is written as a pointer: leading trigger word first, one trigger per branch, no identity the body carries.

Also in this pass: rename `/desplega:research`, `/desplega:create-plan`, `/desplega:implement-plan` to `/researching`, `/planning`, `/implementing` in `system.agent.lead`, `work-on-task`, `start-leader`, `implement-issue`, `one-shot`.

## 7. Identity decision: inject when edited

Today SOUL.md, IDENTITY.md, CLAUDE.md, TOOLS.md are injected for every local agent. The defaults come from `src/prompts/defaults.ts` and are mostly scaffolding ("Vibe: discover and fill in as you work", "Add repos you work with").

Rule for revision 2:
- SOUL.md: always injected. It is the persona.
- IDENTITY.md: injected only when it differs from `generateDefaultIdentityMd()` for that agent. Comparison at render time, whitespace-normalized.
- CLAUDE.md: injected only for codex, opencode, pi, and only when it differs from `generateDefaultClaudeMd()`. Claude loads it natively.
TOOLS.md: never injected, but pointed to. Block C gets: "`/workspace/TOOLS.md` holds your environment notes: repos, hosts, services, tool quirks. Read it when a task touches a repo, host, or service you have not used this session. Update it with `update-profile` `toolsMd`." Remote variant: omitted.

Effect on a fresh agent: SOUL.md only, about 600 tokens. Effect on an agent that edited its files: nothing lost. No migration. The later merge of IDENTITY.md into SOUL.md stays a separate decision.

The defaults themselves get an STE rewrite in this pass, since SOUL.md is prompt text for every agent. "You're not a chatbot. You're becoming someone." becomes a persona statement in the agent's own voice.

## 8. Deferred

- Turn prompt and `work-on-task` (your call, later). Dependency: when the memory paragraph lands, `work-on-task` step 2 is a duplicate and step 1 should become `task-context-gathering`.
- Event intake templates (GitHub, Linear, Slack, AgentMail): an unslop pass of their own.
- scripts-only mode templates.
- IDENTITY.md into SOUL.md merge.
- Desplega family dedupe (`planning`/`v-planning` share 30% of text), `ask-user` and `learning` fate.

## 9. Decisions I need

`memory-store` tool and `memory_store` SDK op in this pass (small server-side addition). Yes or no.
Inject-when-edited for IDENTITY.md and CLAUDE.md (section 7). Yes or no.
Five MUST pointers only (swarm-scripts, memory, slack-interaction, code-quality, heartbeat-runbook). OK, or MUST on every pointer.
Skills plan in section 6. OK.
Remote-variant sentences (devin, claude-managed) as written in C, D, E. OK.

## 10. Execution (after approval)

1. Server: `memory-store` tool + SDK op + `SDK_TOOL_NAME_MAP` entry, tests. (If decision 1 is yes.)
2. Skills: `scheduling`, `memory`, `code-quality`, `slack-interaction`, `heartbeat-runbook` created; `swarm-scripts`, `pages` extended; `artifacts` flagged. Descriptions written as pointers. `bun run check:skill-sources && bun run check:skill-md && bun run check:seed-skill-files`.
3. Templates: rewrite `session-templates.ts` to section 5. New composites: `lead`, `worker`, `worker.pi` (drops only the ctx sentence), `worker.remote`.
4. `base-prompt.ts`: new order, inject-when-edited, provider-gated CLAUDE.md, delete services, artifacts, capabilities, TOOLS.md, shared-dir branches, MCP summary as names.
5. `defaults.ts`: STE rewrite of SOUL.md, IDENTITY.md, CLAUDE.md defaults. Keep TOOLS.md default as is (file still exists).
6. Commands: rename `/desplega:*` references. `bun run build:pi-skills`.
7. Tests: `base-prompt.test.ts`, `prompt-template-session.test.ts`, `scripts-only-gating.test.ts`, `self-improvement.test.ts`, `identity-field-budget` tests, capability-surface tests.
8. Measure: `bun scripts/dump-prompt-variants.ts /tmp/after`, compare with `work/prompt-variants/00-INDEX.md`. Then one evals delegation-probe run on two tiers before and after.
9. Docs: `runbooks/skills.md`, `runbooks/memory-system.md`, docs-site prompt pages, `MCP.md` for the new tool.

### Verification

```bash
bun run tsc:check
bun run test:root -- src/tests/base-prompt.test.ts src/tests/prompt-template-session.test.ts src/tests/scripts-only-gating.test.ts src/tests/self-improvement.test.ts
bun run check:skill-sources && bun run check:skill-md && bun run check:seed-skill-files
bun run check:sdk-tool-registration
bun run build:pi-skills && git diff --stat plugin/pi-skills
bun scripts/dump-prompt-variants.ts /tmp/after && grep '^| 0' /tmp/after/00-INDEX.md
```

### Manual E2E

```bash
rm agent-swarm-db.sqlite && bun run start:http
bun run docker:build:worker && bun run pm2-restart
curl -s -H "Authorization: Bearer $AGENT_SWARM_API_KEY" -H 'Content-Type: application/json' \
  $MCP_BASE_URL/api/tasks -d '{"task":"Store one memory about this task with memory-store, then complete."}'
docker exec <worker> sh -c 'head -c 600 /workspace/logs/*.jsonl | tail -1'     # system prompt the worker sent
docker exec <worker> ls ~/.claude/skills | grep -E 'scheduling|memory|code-quality|slack-interaction|heartbeat-runbook'
# fresh agent: SOUL.md only in the identity section; edited agent: IDENTITY.md appears
# opencode: one repo task, confirm the repo CLAUDE.md instruction is honored without inline injection
```

## 11. Final decisions (2026-08-20)

1. `memory-store` tool + `memory_store` SDK op in this pass: yes.
2. Inject-when-edited for IDENTITY.md and CLAUDE.md: yes.
3. Five MUST pointers only: yes.
4. Skills plan (section 6): yes.
5. Remote-variant sentences: yes.

Amendments from the review of revision 2:
- Swarm messaging is deprecated. `post-message` and `read-messages` leave every prompt, the `system.agent.messaging` block is deleted, and the worker escalation path is `store-progress` (blocker note) then `failed` with a `failureReason`. Block texts above are updated.
- TOOLS.md is not injected, but block C points to it with a trigger ("read it when a task touches a repo, host, or service you have not used this session") and names `update-profile` `toolsMd` as the write path.

Execution (section 10) runs in a new session from the handoff at `~/.claude/hand-offs/2026-08-20-system-prompt-v2.md`.
