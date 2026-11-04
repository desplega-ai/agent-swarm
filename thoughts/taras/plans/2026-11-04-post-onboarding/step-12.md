---
id: step-12
name: "Lead prompts: use-case planning, steering, channel thread"
track: D
depends_on: [step-10]
status: claimed
assignee: po-orch-step-12
claimed_at: 2026-11-04T19:30:00Z
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-12: Lead prompts: use-case planning, steering, channel thread

## Overview
The Lead learns the use-case contract: plan a recurring or long-running job as one use case with one asset key, create the schedule (and any page or app) under that key, and tell the user where it lives (`<APP_URL>/sessions?view=<key>`). It tells one-off asks from lasting changes (one-off = a task in the key; lasting = `update-schedule` and a shown template diff). When a chat channel is connected, it offers once per use case to post each run's summary to a channel thread and remembers the thread in KV. All text goes through the template registry and the seeded `scheduling` skill. After this step, a rendered lead prompt contains the use-case section once, and a live planning session with the Lead ends with a schedule under a group key and a "lives in" line.

## Changes Required:

#### 1. Lead contract template
**File**: `src/prompts/session-templates.ts:87-111` (`system.agent.lead`)
**Changes**: Add a "Use cases" paragraph (static text, cache-stable): agree a short slug with the requester; the key is `shared/<slug>/` (or `personal/<user>/<slug>/` when private); create the schedule, pages and apps with that `key`; write results under the same path (see `system.agent.outputs`); end the planning turn with "This use case lives in Sessions → <slug>: `{{appUrl}}/sessions?view=<key>`" (`appUrl` is already a prompt variable or add it from `getAppUrl()` at the base-prompt call site, `src/prompts/base-prompt.ts:220-233`). Steering: a request inside a use-case session that is a one-time ask runs as a normal task in the key; a request that changes future runs means `update-schedule` with the new `taskTemplate`, then show the before/after diff of the template in the reply and confirm. Use the asd-ste100 skill (Strict mode) on the new paragraph before committing.

#### 2. Channel thread offer
**Files**: `src/prompts/session-templates.ts:307-322` (`system.agent.slack`), the chat-sdk equivalent section in `base-prompt.ts` (search `chat` capability gating), `templates/skills/slack-interaction/content.md`, `templates/skills/chat-sdk/content.md`
**Changes**: When Slack or a Chat SDK adapter is connected (the base prompt already gates these sections on server capabilities), add: after the first run of a use case, offer once to post a summary of each run to a channel thread. If accepted: `slack-start-thread` (`src/tools/slack-start-thread.ts`, returns `ts`) or `chat-post` with `channelId` (`src/tools/chat-post.ts`, returns `threadId`), then `kv-set` with `namespace: "usecase:<key>"`, `key: "thread"`, value `{ adapter, channelId, threadTs|threadId }`. Scheduled runs read it with `kv-get` and reply in the thread (`slack-post` with `threadTs`, `chat-post` with `threadId`). Skills carry the step-by-step; the system template carries the rule only.

#### 3. Scheduling skill
**File**: `templates/skills/scheduling/content.md`
**Changes**: Add the key guidance (inherit from the planning task, or pass `key` explicitly), the "lives in" line, and the one-off vs lasting rule with a `update-schedule` example that prints a template diff. Then `bun run build:skill-md` if a `SKILL.md` sits beside it, and the three skill checks.

#### 4. Tests
**Files**: `src/tests/prompt-template-session.test.ts`, `src/tests/base-prompt.test.ts`, `src/tests/seed-skills-retire.test.ts`
**Changes**: The lead prompt contains the use-case paragraph exactly once and the `sessions?view=` link base; the Slack section contains the thread offer only when Slack is configured; the chat section likewise. Snapshot updates reviewed by hand.

### Success Criteria:

#### Automated Verification:
- [x] `bun run test:root -- <prompt test files touched>`
- [x] `bun run build:skill-md && bun run check:skill-md && bun run check:skill-sources && bun run check:seed-skill-files`
- [x] `bun run check:local && bun run tsc:check:tsc`
- [x] `rg -c "sessions\?view=" src/prompts/session-templates.ts` equals 1

#### Automated QA:
- [x] Render the lead system prompt (same one-off render as step-3) with `SLACK_BOT_TOKEN` set and unset: the thread offer appears only in the first.
- [ ] Host-run lead recipe (`project_host_run_lead_local_stack` memory, or the compose bundle with one lead): send "Track our competitors twice a week and keep a report I can compare over time" through the UI composer. Assert via API: a schedule exists with `key` matching `shared/<slug>/`, the planning task has the same key, the final reply contains `/sessions?view=shared/<slug>/`. Record the transcript path.
- [ ] Follow up in that session with "from now on also include pricing": assert `update-schedule` was called (`GET /api/schedules/<id>` template changed) and the reply shows a diff block.

#### Manual Verification:
- [ ] Taras reads the two new paragraphs and the skill diff for tone and length.
- [ ] Taras accepts the thread offer once on the dev Slack channel and sees the next run's summary land in the thread.

**Implementation Note**: This step is a vertical slice, QA-able on its own with a live lead. Prompt writing stays in Claude (spec is the work). After completing this step, pause for manual confirmation. Commit as `[step-12] Lead prompts: use-case planning, steering, channel thread` after verification passes.

## Implementation notes

Commit `7c75a2a83` on `po/step-12` (2026-11-04). All by Claude (prompt work, no Codex round).

- **Lead contract** (`system.agent.lead`): a use-case block of 5 lines, rewritten with asd-ste100 Strict. New template variable `appUrl` = `getAppUrl()` (deployment-level, so the prompt stays cache-stable; without `APP_URL` it renders the default `https://app.agent-swarm.dev`). The step-14 line next to it still says `APP_URL` + `/integrations/tools` (not touched). Fresh-lead size ceiling in `base-prompt.test.ts` moved from 6,250 to 7,100 (the block is about 790 chars).
- **Deviation: apps.** `app-upsert` has no `key` field, so the contract names only `create-schedule` and `create-page`.
- **Deviation: channel thread is one lead-only section, not edits to `## Slack`.** There is no Chat SDK section in the system prompt today, and every posting tool (`slack-start-thread`, `slack-post`, `chat-post`) is lead-only. So a new `system.agent.lead.channel_thread` renders once for a lead when the Slack prompt tools are on (same gate as `## Slack`) or the server reports `chat-sdk`, never in scripts-only mode. Workers never get it. The rule: offer once in the planning session after the first run, check `kv-get usecase:<key>/thread` first, store the thread or `{ declined: true }` (so "once" holds), and post each run summary when the lead finishes or reviews a run (a worker's run reaches the lead as a follow-up, which inherits the run's key). Steps live in `slack-interaction` and `chat-sdk`.
- **Per-task key** (orchestrator note from step-3): new `task.use_case` template, rendered by `buildTaskSessionPrompts` for a lead only when the task key is a use-case group (`isGroupKey && !sourceOfKey`, the rule `resolveTaskGroupKey` uses for inheritance). It names the key and points at `list-schedules`. The fresh and resume paths both pass the key (`taskKey`). Documented in the harness-providers per-task table with the new system section.
- **Skills**: `scheduling` gets "Use cases: one key" with the one-time vs lasting rule and an `update-schedule` + `diff` example. No `SKILL.md` sits beside the three edited skills, so `build:skill-md` writes nothing.
- **Tests**: `seed-skills-retire.test.ts` not touched (it covers retirement, nothing in this step). New cases in `prompt-template-session`, `base-prompt` (use-case block once, link base, thread offer with Slack, with `chat-sdk`, both, neither, worker, scripts-only) and `task-session-prompts` (note in the task prompt only, lead only, group keys only).
- **Verification**: touched tests 194 pass. `check:local` exit 0 (two earlier runs each had one load flake, `steering-core` and `mcp-input-caps`, both pass alone and on the rerun). `tsc:check:tsc`, `lint`, `lint:slop`, `check:dep-graph`, `check-db-boundary` pass. Skill checks pass. `rg -c` = 1.
- **QA render**: lead with Slack tokens: thread section 1. Slack disabled: 0. Slack disabled plus `chat-sdk` capability: 1. Runner split dump (`/tmp/po-step-12-lead-system-prompt.txt`, `/tmp/po-step-12-task-prompt.txt`): system has `## Outputs`, files-first, use-case block and `sessions?view=` once each, no nudge, no key. Task prompt has `## Use case` once, the nudge once, none of the system sections.
- **Live QA** (host-run Claude lead, temp HOME, API and UI on free ports, fresh DB): composer message "Track our competitors twice a week..." gave schedule `competitor-watch` with key `shared/competitor-watch/` (disabled until the user sends the competitor list) and the reply line "This use case lives in Sessions → competitor-watch: http://localhost:58076/sessions?view=shared/competitor-watch/". "from now on also include pricing" in the session: pricing was already in the template, so the lead changed nothing and proposed a diff. "From now on also include each competitor's open job posts" through the group's Ask the Lead (key `shared/competitor-watch/`, the task prompt carried `## Use case`): `update-schedule` ran, `GET /api/schedules/<id>` template changed (new Open jobs heading), and the reply had a `diff` block and asked to confirm. Transcripts: `/tmp/po-step-12-transcript-{a3ed7bf2,fa035fa4,90a647a4}.jsonl`.
- **QA boxes 2 and 3 left unticked.** Box 3: the literal pricing message caused no update (pricing was already in the template), the variant above passed. Box 2 gap: the planning task keeps `shared/task:<id>/` when the planning starts in the Inbox. No agent tool can move a session into a group (`/api/session-moves` is HTTP-only). The planning task carries the use-case key only when the session starts inside the group (Sessions composer "Start in", or Overview "Ask the Lead"). Follow-up: a lead-callable session move (MCP tool), or let `create-schedule` file the calling root session into the new group.
- **Notes for others**: the step-14 nudge offered "add a first-use-case plan" in the steering reply although a schedule under `shared/competitor-watch/` existed (the schedule was disabled; check the step-13 use-case signal). The lead also repeated the "lives in" line on a steering reply (harmless).

