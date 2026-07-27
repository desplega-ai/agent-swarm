---
id: step-10
name: Slack thread steering (config-gated)
depends_on: [step-1]
status: done
completed_at: 2026-07-27
---

# step-10: Slack thread steering

## Overview

Turns an in-thread Slack reply into a steering message for the thread's **lead** task when that task is `in_progress` — behind a new config flag, respecting the existing `ADDITIVE_SLACK` debounce buffer, and leaving the mention gate untouched. Everything else falls back to today's behavior.

Binding decisions: **5** (steer only the thread's latest lead task; worker/child tasks excluded entirely), **15** (qualifying replies still flow through the debounce window and the flush emits **one** steering message instead of a dependent follow-up task; `SLACK_THREAD_FOLLOWUP_REQUIRE_MENTION` semantics unchanged), **1** (config chooses steer-vs-queue mode).

**This step owns `src/slack/**`.** Consumes step-1's `getLatestLeadTaskInThread()` and the core steering service.

## Changes Required:

#### 1. Config flag
**Files**: `src/slack/` (read site), documented alongside other Slack flags
**Changes**: Add `SLACK_THREAD_STEERING` = `off` (default) | `lead` | `all`, plus `SLACK_THREAD_STEERING_MODE` = `queue` (default) | `steer`.

Follow the existing pattern exactly: `SLACK_THREAD_FOLLOWUP_REQUIRE_MENTION` is read as a raw `process.env` lookup at `src/slack/router.ts:33-34`. Values in the `swarm_config` table are materialised into `process.env` by `reloadGlobalConfigsAndIntegrations()` (`src/http/config.ts:276-286`, route `POST /api/config/reload` at `:142-149`), and global-scope config **writes** already auto-trigger a debounced (~250ms) reload (`:193, :216, :376-377`) — so no explicit reload call is needed after a `PUT /api/config`.

**Default `off`** — this changes user-visible Slack behavior and should be opt-in.

**Decision 16 on the Slack path**: always call with `onUnsupported: "degrade"`. Slack has no good way to surface a `422` to a human mid-thread, and dropping the message would be worse than delivering it late. When a downgrade happens (configured `steer` against a claude lead task), reflect it in the ack — e.g. `:eyes:` plus a short thread note that it was queued — rather than letting the user believe they interrupted the agent.

#### 2. Buffer flush emits one steering message
**File**: `src/slack/thread-buffer.ts`
**Changes**: `slackFlush(items, key, immediate)` (`:122-216`) is the branch point. Today it concatenates buffered messages into one `combinedText`/`description` (`:144-145`), resolves `getLatestActiveTaskInThread(channelId, threadTs)` (`:148`), sets `dependsOn = [latestActiveTask.id]` when not immediate (`:165`), and creates a dependent follow-up task via `createTaskWithSiblingAwareness` (`:168-177`).

Insert the steering decision **right after `:148`**:

1. If `SLACK_THREAD_STEERING === "off"` → unchanged path.
2. Resolve the thread's lead task via step-1's `getLatestLeadTaskInThread(channelId, threadTs)`. None of the three existing lookups filter on lead-ness (`db.ts:2315-2330`, `:2336-2350`, `:2357-2368`) — that's exactly why step-1 added this helper.
3. If that task exists and is `in_progress` → call the core steering service **once** with the already-concatenated `combinedText` and the configured mode, then post the ack/summary. **Do not** create a task.
4. Otherwise → unchanged path (new task, today's behavior).

Decision 15 means the debounce is **not** bypassed: the existing `BUFFER_TIMEOUT_MS` window (`:19`, `ADDITIVE_SLACK_BUFFER_MS`, default 10s) still applies, and the `!now` instant-flush path (`:76-78`) still works.

`SLACK_THREAD_STEERING === "all"` relaxes step 2 to `getLatestActiveTaskInThread` (any task, not just the lead's) — decision 5's `lead` mode is the default and the documented behavior.

#### 3. Non-buffered path
**File**: `src/slack/handlers.ts`
**Changes**: When `ADDITIVE_SLACK` is off, the busy-worker branch at `:714-724` runs. Note this branch is **reporting-only** today: the task is created unconditionally at `:704-712`, and the busy check merely routes the result into `results.queued` vs `results.assigned` for the summary message. The lead path `continue`s earlier at `:686-701` and skips the busy check entirely.

Apply the same lead-task-in-progress decision **before** task creation on this path so a qualifying reply steers instead of creating a task.

#### 4. Ack UX
**Files**: `src/slack/handlers.ts`, `src/slack/blocks.ts`
**Changes**:
- Add an `:eyes:` reaction on a message accepted for steering. Call shape template: `client.reactions.add({ channel, name: "zap", timestamp })` at `handlers.ts:507` (and `:547`) → use `name: "eyes"`.
- Add a "steered" marker to the evolving tree message. The rendering lives in `src/slack/blocks.ts` — `buildTreeBlocks(roots: TreeNode[])` (`:536`) consuming `TreeNode` (`:218`) — **not** in `watcher.ts`, which only tracks state maps and calls into `blocks.ts`. The watcher's 3s loop (`watcher.ts:466-769`, `processTreeMessages()` at `:531`) will pick up the re-render automatically.
- Optionally swap the reaction to `:white_check_mark:` once the row reaches `handled`.

#### 5. Mention gate untouched
**File**: `src/slack/router.ts`
**Changes**: **No behavioral change.** `SLACK_THREAD_FOLLOWUP_REQUIRE_MENTION` still gates the thread-follow-up branch at `:62`; a reply that doesn't qualify today still doesn't steer (decision 15). Verify by test, don't refactor.

### Success Criteria:

#### Automated Verification:
- [ ] Typecheck passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint`
- [ ] Tests pass: `bun test src/tests/slack-steering.test.ts` (new — cover: `off` preserves today's path exactly; `lead` + in-progress lead task → one steering message and **zero** tasks created; `lead` + in-progress **worker** task → task created, no steer (decision 5 exclusion); terminal lead task → task created; buffered multi-message flush produces exactly **one** steer; mention gate unchanged in both modes)
- [ ] Existing Slack tests still pass: `bun test src/tests/slack-*.test.ts`
- [ ] Full suite green: `bun test`
- [ ] DB boundary holds: `bash scripts/check-db-boundary.sh`

#### Automated QA:
- [ ] Agent shows the flag round-trips through config: `PUT /api/config` with `{"SLACK_THREAD_STEERING":"lead"}` then `POST /api/config/reload`, and `GET /api/config?includeSecrets=true` reflects it
- [ ] Agent drives the handler path directly (unit/integration harness, no live Slack needed) proving: buffered replies → one steering row; `off` → task creation unchanged
- [ ] Agent verifies the debounce is respected — two replies inside `ADDITIVE_SLACK_BUFFER_MS` produce **one** steering message with both bodies concatenated (decision 15)

#### Manual Verification:
- [ ] Live Slack round-trip in the dev channel `#swarm-dev-2` (`C0AR967K0KZ`) with bot `@dev-swarm` (`U0ALZGQCF96`): post `<@U0ALZGQCF96> start a long task`, reply in-thread while it runs, and confirm the `:eyes:` reaction, the single steering message after the debounce window, and the "steered" marker on the tree message
- [ ] Taras confirms the default should stay `off` for the first release

**Implementation Note**: Vertical slice — one config flag flips a well-defined behavior with a clean fallback. Do not touch `src/be/db.ts` (step-1 owns `getLatestLeadTaskInThread`). Commit `[step-10] Slack thread steering behind SLACK_THREAD_STEERING`.
