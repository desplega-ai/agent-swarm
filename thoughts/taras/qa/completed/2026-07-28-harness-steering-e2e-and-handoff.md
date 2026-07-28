---
date: 2026-07-28
author: Claude (Fable 5)
topic: Harness steering — live E2E results + session handoff
branch: feat/harness-steering
status: implemented, E2E-verified, awaiting PR
---

# Harness Steering — E2E Results & Handoff

## Where things stand

**All 11 steps of `thoughts/taras/plans/2026-07-27-harness-steering/` are implemented, merged into
`feat/harness-steering`, and E2E-verified against real providers.** 29 commits ahead of `main`, working
tree clean, no worktrees left behind.

Implemented via `/v-implement` in autopilot: 4 waves, Codex sol/terra in isolated worktrees plus one
Opus agent for the UI. Then a live E2E on a clean DB with Docker workers — which is where the real bugs
came out.

## What shipped

- **Server**: migration `121_task_steering_messages`, `src/be/steering.ts` (`requestSteering` + the
  `steer → queue → follow-up task` ladder + `onUnsupported: degrade|fail`),
  `promotePendingSteeringForTask` on terminal status, heartbeat stall grace,
  `getLatestLeadTaskInThread`, RBAC `task.steer.{own,any}`.
- **Routes**: `POST /api/tasks/{id}/steer`, `GET /api/tasks/{id}/steering-messages`,
  `GET /api/steering-messages`, and worker callbacks
  `POST /api/steering-messages/{id}/{delivered,undeliverable,handled}`.
- **Worker**: poll → dispatch → report spine in `runner.ts`, `accept-steer` tool, prompt section via
  the registry.
- **Providers**: `deliverSteering?()` on `ProviderSession`, `steerModes?: SteerMode[]` on
  `ProviderTraits` (**absent means `[]`**).
- **Surfaces**: `steer-task` MCP tool (agent + user), `task_steer` script SDK, UI composer + status
  section, Slack thread steering behind `SLACK_THREAD_STEERING`.
- **`STEERING_DISABLE=true|1`** global kill-switch (mirrors `SLACK_DISABLE`). Gates the write path, MCP
  registration, worker poll, prompts, and Slack. Deliberately does NOT gate the read endpoints, the
  worker callbacks (in-flight messages must drain), or the terminal promotion sweep.

## Current capability matrix — this diverges from the plan; trust this table

| provider | steerModes | `mode:"steer"` outcome | E2E status |
|---|---|---|---|
| pi | `["steer","queue"]` | `steered` | ✅ full lifecycle verified (steer mode) |
| claude-managed | `["steer","queue"]` | `steered` | ⬜ not tested (deferred) |
| devin | `["queue"]` | `queued` | ⬜ not tested (deferred) |
| opencode | `["queue"]` | `queued` | ✅ queue verified; steer narrowed after E2E failure |
| claude | `["queue"]` | `queued` | ✅ full lifecycle `pending→delivered→handled` |
| codex | `[]` | `promoted` | ✅ both modes → real follow-up tasks |

`src/tests/provider-steering-capabilities.test.ts` asserts adapter traits == the static map.

## Five real bugs the E2E found, all fixed

1. **`handled` was unreachable.** The prompt told the agent to call `accept-steer` with the steering
   message ID, but the runner injected only `message.body` — no ID ever reached the agent. Messages
   were delivered and obeyed, then sat at `delivered` forever. Fixed with registered template
   `system.agent.steering.delivery`, which wraps the body in `[steering <id>]`.
2. **`accept-steer` hit the wrong swarm.** It looped back over HTTP via `getMcpBaseUrl()`, which is the
   *public* origin in most deployments (an ngrok tunnel locally) → 404 against a different server.
   **`src/tools/` is API-server-side per CLAUDE.md and may import `src/be/db` directly** — the earlier
   brief to step-3 wrongly fenced it as worker-side, which is where the HTTP hop came from.
3. **Removing that hop dropped authorization.** The task-assignment check lived in the HTTP route;
   `assertOwnsTask` does not cover it because it routes through RBAC, which grants-all under the
   default legacy policy. The assignment check is now explicit in the tool.
4. **opencode's interrupt does not work.** `session.abort` + re-prompt returned undeliverable and the
   message was promoted instead of reaching the session. Narrowed to `["queue"]` (queue verified
   working; the model demonstrably obeyed). Revisit if the abort+prompt path gets fixed.
5. **UI attribution was wrong.** Dashboard-sent steers recorded `source:"api"` /
   `createdByKind:"system"`. The route now accepts an optional `source`; the UI client sends `"ui"`.

Two earlier divergences, decided during implementation:

- **devin is queue-only** — its message API accepts a `working` session but does not guarantee the
  in-flight turn is interrupted.
- **claude's stream-json path is triple-gated** — queued steering needs `--input-format stream-json`,
  mutually exclusive with `-p <prompt>`, so enabling it changes how *every* claude task launches.
  Enabled only when the CLI probes `>= 2.1.205` AND the binary is not a bridge/tmux wrapper AND the new
  `CLAUDE_QUEUE_STEERING=0|1` kill-switch does not force it off. Otherwise `-p` is kept and no
  `deliverSteering` is exposed.

## Open items

1. **`package.json` must reach `1.122.0`** or the UI composer never renders — it is behind
   `useFeatureGate("1.122.0")`. Run `bun run prepare-release` and commit all regenerated files. This is
   a release action, deliberately left to Taras. (Bumped temporarily during E2E, then reverted.)
2. **Unresolved: pi's `followUp()` semantics.** Queue-mode delivery lands in the agent's *next*
   session, not the current run's next turn — a message queued for task A was acknowledged while the
   agent was running task B. Worth chasing before relying on pi queue mode.
3. **Untested providers**: `claude-managed` and `devin` (E2E was scoped to claude/pi/opencode/codex).
4. **PR not opened.** Branch is local only.
5. **Slack E2E not run** — the `SLACK_THREAD_STEERING` path is unit-tested only.
6. Step-1's manual checkpoint was skipped under autopilot: confirm the `task_steering_messages` column
   set and the `steered`/`queued`/`promoted` vocabulary.

## Gotchas for whoever picks this up

- **`CORE_TOOLS` / `DEFERRED_TOOLS` / `ALL_TOOLS` in `src/tools/tool-config.ts` have zero production
  consumers.** They are classification only; moving a tool between them changes nothing at runtime.
  Tool deferral is Claude Code's own behavior, triggered above ~10K tool tokens.
- **The full `bun test` suite is load-sensitive on this machine** — it failed 50–130 assorted unrelated
  tests under load and reproduced identically on `main`, so it is environmental, not a branch
  regression. Protocol that works: `find . -maxdepth 1 -name 'test-*.sqlite*' -delete` before every run
  (leftover test DBs poison the next run), never run suites concurrently across worktrees, check
  `uptime` first.
- **E2E scripts are in `/tmp/e2e/`** (`lib.sh`, `worker.sh`, `steer-turns.sh`, `steer-test.sh`,
  `mcp-tools.sh`). `worker.sh <provider>` starts a container with
  `MCP_BASE_URL=http://host.docker.internal:3013`. Codex needs `OPENAI_API_KEY` passed explicitly — it
  lives in `.env`, not `.env.docker`.
- **Start the API with `MCP_BASE_URL=http://localhost:3013`** for local E2E. The repo `.env` points at
  an ngrok tunnel, which silently sends server-side tool callbacks to the wrong swarm — this is exactly
  what masked bug #2.
- Task read responses are **unwrapped** (`{id, status, ...}`), not `{task: {...}}`.
- OrbStack's docker daemon died three times mid-run; `orb start` recovers it.
- A long-running task for steering tests needs explicit per-step shell sleeps in separate commands, or
  the model finishes before there is a turn boundary to steer into.

## References

- Plan: `thoughts/taras/plans/2026-07-27-harness-steering/` (root.md + step-1..11, all `status: done`)
- Research: `thoughts/taras/research/2026-07-24-harness-steering.md`
- Docs written by step-11: `docs-site/content/docs/(documentation)/guides/task-steering.mdx`,
  `runbooks/harness-providers.md`, `MCP.md`
