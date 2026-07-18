---
date: 2026-07-18T16:00:00+02:00
researcher: Claude
git_commit: d33d280c
branch: spike/extension-system
repository: agent-swarm
topic: "Extension-system spike: Layer 1 (event subscriptions) implementation + findings"
tags: [spike, extensions, subscriptions, event-bus, scripts-runtime, latency]
status: complete
autonomy: autopilot
last_updated: 2026-07-18
last_updated_by: Claude
---

# Spike: Extension System — Layer 1 (Event Subscriptions)

Companion to `2026-07-18-swarm-extension-system.md` (the research + proposal).
This spike implements the proposal's MVP slice on branch `spike/extension-system`
and records what it validated, what it changed vs. the proposal, and the
measured answer to the `tool.before_call` latency question.

## What was built

**"On event X, run script/workflow Y"** — the react-to-things primitive, end to end:

| Piece | File | Notes |
|---|---|---|
| Migration | `src/be/migrations/117_swarm_events_subscriptions.sql` | `swarm_events` (journal), `subscriptions`, `subscription_deliveries` (outbox, `UNIQUE(subscriptionId, eventId)` dedupe) |
| Bus tap | `src/workflows/event-bus.ts` | `onAny`/`offAny` added to `WorkflowEventBus` — every emit reaches the capture layer without touching any emit site |
| Types | `src/subscriptions/types.ts` | module-local Zod schemas (production: hoist to `src/types.ts`) |
| Matcher | `src/subscriptions/matcher.ts` | dot-segment glob: `*` = one segment, `**` = rest (last segment only) |
| DB layer | `src/be/subscriptions-db.ts` | CRUD + atomic claim (`UPDATE … WHERE id IN (SELECT … LIMIT n) RETURNING *`) |
| Dispatcher | `src/subscriptions/dispatcher.ts` | capture (pattern + reused `wait-filter` language) → deliveries; scheduler-style poller executes script targets (same invocation pattern as `executeScheduleScript`) and workflow targets (`triggerType: "subscription"` added to the engine union); MAX_ATTEMPTS=3 retry |
| MCP tools | `src/tools/subscriptions/` | `create-subscription` (validates pattern + target existence), `list-subscriptions` (with recent deliveries), `delete-subscription`; registered in `server.ts`, DEFERRED_TOOLS, EXCLUDED from scripts SDK for now |
| Boot | `src/http/index.ts` | `startSubscriptionDispatcher()` unless `SUBSCRIPTIONS_DISABLE=true`; `SUBSCRIPTIONS_INTERVAL_MS` (default 2000) |
| Tests | `src/tests/subscriptions.test.ts` | 6 tests: matcher semantics, capture w/ filter + disabled exclusion, real sandboxed script execution with `args.event` injection, retry→failed (attempts=3), workflow trigger with `{event, subscriptionId}` trigger data |
| Latency probe | `scripts/spike-script-spawn-latency.ts` | see below |

Verification run: `bun run tsc:check` ✓, `bun run lint` ✓, full `bun test` ✓
(6268 pass; one pre-existing tool-count band in `tool-annotations.test.ts`
bumped 120→125 for the 3 new tools), `check-db-boundary.sh` ✓,
`check:dep-graph` ✓ (0 errors), `check-sdk-tool-registration` ✓ (18 excluded),
migration verified against fresh DB **and** a copy of the dev DB, `MCP.md`
regenerated (124 tools).

## Measured: scripts-runtime spawn latency

`AGENT_SWARM_API_KEY=123123 bun scripts/spike-script-spawn-latency.ts`
(trivial script through the full sandbox: ulimit preamble + `env -i` +
stdin config + eval harness), 10 runs after 2 warmups, on the M-series dev box:

```
min=61ms  p50=179ms  p95=215ms  max=215ms
```

**Verdict for the proposal's open question:** ~180ms typical is
**unacceptable for a synchronous per-tool-call hook** (`tool.before_call`) —
agents make many tool calls per minute and this would dominate dispatch time.
It is **perfectly fine** for the cold paths (`task.before_create`,
`event.before_task`, subscription dispatch). `tool.before_call` therefore
needs one of: (a) a resident warm hook-runner process (pool of pre-spawned
harnesses fed over stdin), (b) matcher-gating so the sandbox only spawns for
explicitly named tools (Claude Code-style), or (c) an in-process trusted-tier
evaluator for operator-installed hooks only. Recommendation: (b) for v1,
(a) if usage grows.

## What the spike validated

1. **The `onAny` tap is the right capture point.** Zero emit sites changed;
   Slack/Linear/Jira remain the only gap (they don't emit at all yet — still
   the one-line follow-ups listed in `runbooks/workflows.md`).
2. **The scheduler is a ready-made template.** Poller shape, script invocation
   (credential bindings, connection descriptors, timeout), and the
   executor-registry injection/fallback pattern all transplanted cleanly.
3. **Reusing the wait-node filter language works** — one filter dialect across
   wait nodes and subscriptions, no new DSL.
4. **The scripts sandbox is a viable extension runtime**: real scripts received
   the event payload as `args.event`, ran, failed, and retried exactly as
   designed, inside the existing resource limits.
5. **The event journal write is cheap** and only happens when ≥1 subscription
   matches (spike behavior — see trade-offs).

## Deviations from the proposal / spike shortcuts (production TODOs)

- **Events are journaled only when a subscription matches.** The proposal's
  "durable journal of everything" would bloat on `task.progress`; decide a
  retention/filter policy (e.g. journal all except a denylist, TTL cleanup in
  `cleanupStaleResources`).
- **Capture is in-process** (tap → async persist). True transactional emit
  (event row written in the same transaction as the state change) needs the
  emit-site refactor; deferred with rationale in the dispatcher header comment.
- **No RBAC verbs yet** (`subscription.write` etc. — research gap #11); tools
  are currently ungated like most main-surface tools. Add before merge.
- **Zod schemas are module-local** (`src/subscriptions/types.ts`), not in
  `src/types.ts`.
- **Not exposed to the scripts SDK** (EXCLUDED_TOOLS) — flip to
  `SDK_TOOL_NAME_MAP` + regenerate `swarm-sdk.d.ts` once the design settles,
  so scripts can self-subscribe.
- **Multi-replica claim/lease** (gap #12) untouched — single-statement UPDATE
  claim is single-process-safe only.
- **No HTTP routes / UI** — MCP-only surface for the spike.
- **No pause tool** (`setSubscriptionEnabled` exists in the DB layer; only
  create/list/delete are exposed).
- **Manual E2E not run** (server + live task lifecycle); unit tests exercise
  the real sandbox and real workflow engine. Suggested manual check:
  `bun run start:http`, `create-subscription` on `task.completed` → a noop
  global script, complete any task, `list-subscriptions includeDeliveries=true`.

## Next steps (if promoted from spike)

1. RBAC verbs + `patch-subscription`/pause tool + schemas → `src/types.ts`.
2. Wire Slack/Linear/Jira/heartbeat emitters onto the bus (unlocks the
   integration-pack scenario).
3. SDK exposure (`subscription_create` et al.) so agents/scripts self-serve.
4. Journal retention policy + events HTTP listing for the UI.
5. Then Layer 3 (script-backed tools) — independent of all of the above.
