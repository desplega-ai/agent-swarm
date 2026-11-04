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
- [ ] `bun run test:root -- <prompt test files touched>`
- [ ] `bun run build:skill-md && bun run check:skill-md && bun run check:skill-sources && bun run check:seed-skill-files`
- [ ] `bun run check:local && bun run tsc:check:tsc`
- [ ] `rg -c "sessions\?view=" src/prompts/session-templates.ts` equals 1

#### Automated QA:
- [ ] Render the lead system prompt (same one-off render as step-3) with `SLACK_BOT_TOKEN` set and unset: the thread offer appears only in the first.
- [ ] Host-run lead recipe (`project_host_run_lead_local_stack` memory, or the compose bundle with one lead): send "Track our competitors twice a week and keep a report I can compare over time" through the UI composer. Assert via API: a schedule exists with `key` matching `shared/<slug>/`, the planning task has the same key, the final reply contains `/sessions?view=shared/<slug>/`. Record the transcript path.
- [ ] Follow up in that session with "from now on also include pricing": assert `update-schedule` was called (`GET /api/schedules/<id>` template changed) and the reply shows a diff block.

#### Manual Verification:
- [ ] Taras reads the two new paragraphs and the skill diff for tone and length.
- [ ] Taras accepts the thread offer once on the dev Slack channel and sees the next run's summary land in the thread.

**Implementation Note**: This step is a vertical slice, QA-able on its own with a live lead. Prompt writing stays in Claude (spec is the work). After completing this step, pause for manual confirmation. Commit as `[step-12] Lead prompts: use-case planning, steering, channel thread` after verification passes.
