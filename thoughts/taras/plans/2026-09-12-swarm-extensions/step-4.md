---
id: step-4
name: pre.slack.route
depends_on: [step-2]
status: ready
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-4: pre.slack.route

## Overview
After this step an enabled extension can route a Slack message from channel X to agent Y, force it to the lead, broadcast it, or ignore it, before the built-in router runs. Motivating example 1 passes as a fixture. Only the Slack message handler fires the event; the assistant API, modal actions, and thread-buffer flush stay untouched (brainstorm Key Decisions).

## Changes Required:

#### 1. Dispatch in the message handler
**File**: `src/slack/handlers.ts`
**Changes**: Immediately before `routeMessage` at line 584 (after dedup, bot filtering, buffer check, and `routingThreadContext` at 581-583), call `dispatchPre("pre.slack.route", { channelId: msg.channel, userId: msg.user, text: routingText, threadTs: msg.thread_ts, botMentioned: botMentioned || isImplicitMention, threadContext: routingThreadContext })`.
- `block`: log at info level with the reason and `return` (same shape as the "not mentioned, no matches" early return at 591). No task, no reply.
- `modify` with `target.kind === "agent"`: load the agent by id with the existing getter; if it exists set `matches = [{ agent, matchedText: "extension" }]` and skip `routeMessage`; if it does not exist `console.warn` and fall through to `routeMessage`.
- `modify` with `target.kind === "lead"`: `matches = [{ agent: leadAgent, matchedText: "extension" }]` via `getLeadAgent()`.
- `modify` with `target.kind === "broadcast"`: build the same matches array the router builds for `swarm#all` (reuse the router's helper; export it from `src/slack/router.ts` if it is private).
- `continue`: unchanged path.
Keep the rest of the handler (rate limit, queued requests, task creation at 637/739/756) as is; the branches already consume `matches`.

#### 2. Post event
**File**: `src/extensions/post-bridge.ts`
**Changes**: Confirm the `slack.message` bus emit at `src/slack/handlers.ts:481` carries `channelId`, `userId`, `text`, `threadTs`, and (if available) `taskId`; map it to `post.slack.message`. If the emit lacks a field the brainstorm table lists, add it to the emit payload (additive, existing consumers ignore extra keys).

#### 3. Fixtures and tests
**File**: `src/tests/extensions-slack-route.test.ts` (new), `src/tests/fixtures/extensions/{route-channel-to-agent,ignore-channel}.ts`, `src/tests/extensions-examples.test.ts`
**Changes**: Copy the harness from `src/tests/slack-thread-buffer.test.ts:50-62` (hand-built `App`-shaped object, captured `messageHandler`, real temp SQLite). Register a lead and a worker agent. Cases: with `route-channel-to-agent` configured `{ channelId: "C1", agentId: <worker> }`, a message in `C1` with a bot mention creates a task assigned to the worker and a `modify` run row; a message in `C2` goes to the lead as today; `ignore-channel` blocks `C3` and no task is created; a modify naming an unknown agent falls back to the router with a warning; `post.slack.message` fires with the channel id. Add example 1 to `extensions-examples.test.ts`.

### Success Criteria:

#### Automated Verification:
- [ ] `bun run test:root -- src/tests/extensions-slack-route.test.ts src/tests/extensions-examples.test.ts`
- [ ] `bun run test:root -- src/tests/slack-router.test.ts src/tests/slack-router-require-mention.test.ts src/tests/slack-thread-buffer.test.ts src/tests/slack-bot-filter.test.ts` (existing routing behavior unchanged)
- [ ] `bun run tsc:check && bun run lint`
- [ ] `bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts`

#### Automated QA:
- [ ] `bun run e2e --only slack-mention` still passes (the mock workspace path through the handler is unchanged when no extension is enabled).
- [ ] Extend or add an e2e scenario stub: with `route-channel-to-agent` enabled via the API, a mention in the configured mock channel produces a task whose `agentId` is the configured worker (`ctx.db` read-only assertion). If wiring the scenario is more than an hour, leave the scenario file as a TODO for step-9 and record it in the step notes.

#### Manual Verification:
- [ ] Optional: in `#swarm-dev-2` with a local API and the fixture pointed at a real worker id, one mention lands on that worker. Skip if the local Slack app is not running.

**Implementation Note**: This step is a vertical slice — QA-able on its own. After completing this step, pause for manual confirmation. Taras handles commits.
