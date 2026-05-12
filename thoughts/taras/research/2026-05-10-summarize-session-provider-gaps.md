---
date: 2026-05-10T00:00:00Z
researcher: Claude
git_commit: 9a76c96f9b859fdd853c45fa4af1b0b9fef3e77f
branch: main
repository: agent-swarm
topic: "summarizeSession implementation gaps across harness providers (claude, pi, codex, opencode)"
tags: [research, codebase, harness-providers, session-summarization, memory, hooks, pi-mono, opencode, codex]
status: complete
autonomy: verbose
last_updated: 2026-05-10
last_updated_by: Claude
revisions:
  - "v1 (2026-05-10): initial audit"
  - "v2 (2026-05-10): folded in file-review feedback — pi-ai SDK discovery, dead-code correction for LlmRater/ClaudeCliLlmRaterClient, per-provider auth handling, unified wrapper proposal"
---

# Research: summarizeSession implementation gaps across harness providers

**Date**: 2026-05-10
**Researcher**: Claude
**Git Commit**: 9a76c96f
**Branch**: main

## Research Question

How is `summarizeSession` implemented across the different harness providers (claude, pi, codex, opencode), and what are the gaps?

Specifically:
1. Pi and opencode appear to fall back to invoking the `claude` CLI for summarization, which would be wrong because the `claude` binary may not be available in those provider environments.
2. Codex hooks may not be implemented at all — does session summarization happen for codex?

Scope per Taras: deep on pi / opencode / codex; quick baseline check on claude (the working path); skip devin and claude-managed (different flow, intentionally not supported).

## Summary

End-of-session summarization (extracting "high-value learnings" from a session transcript and indexing them as `source: "session_summary"` memories) is **fully working only for the `claude` provider today**. All three other audited providers are broken in different ways:

- **Claude (working baseline)**: Claude Code's native `Stop` hook fires `bunx @desplega.ai/agent-swarm hook`, which dispatches to `src/hooks/hook.ts:1043`. That handler reads the transcript path provided by Claude Code, calls `runMemoryRater()` (`src/be/memory/raters/llm-summarizer.ts:134`) which `fetch`es OpenRouter directly, and POSTs the result to `/api/memory/index`. No CLI shellout. Gated on `OPENROUTER_API_KEY`.

- **Pi (broken at the LLM call)**: `src/providers/pi-mono-extension.ts:280` defines a `summarizeSession()` that shells out to `${process.env.CLAUDE_BINARY || "claude"} -p --model haiku --output-format json` (line 332) on `session_shutdown`. The `claude` binary is actually present in the worker image (Dockerfile.worker:84 installs it for all providers), but `claude -p`'s auth typically needs `ANTHROPIC_API_KEY` or a Claude OAuth token — pi sessions usually authenticate via `OPENROUTER_API_KEY` or pi's own `auth.json`, neither of which the bare `claude` invocation recognizes. All errors are silently swallowed; on failure the agent terminates cleanly with no summary indexed.

- **Opencode (effectively dead code)**: `plugin/opencode-plugins/agent-swarm.ts:236` defines a near-identical `summarizeSession()` with the same broken `claude` shellout at line 288. **However**, it is invoked at line 369 with `summarizeSession(config, undefined)` because opencode's `session.idle` event does not expose a transcript file path. The function's first statement (`if (!sessionFile) return;` at line 240) makes the entire body unreachable. Net effect: no summarization runs at all in opencode today. The "broken claude shellout" exists in the source but never executes.

- **Codex (entirely absent)**: Grep across `src/providers/codex-*.ts` for `summarize|session_end|SessionEnd|session-end` returns zero matches. Codex has no harness-side hooks at all (no equivalent of Claude Code's `~/.claude/settings.json` `Stop`/`SessionStart`/`Pre|PostToolUse`/`UserPromptSubmit`). It only has *adapter-side* swarm event listeners (cancellation polling, tool-loop detection, heartbeat, activity, context-usage, completion) wired through `src/providers/codex-swarm-events.ts` → `src/providers/swarm-events-shared.ts`. There is no transcript read, no LLM rater call, no `/api/memory/index` POST at end of a codex session. The only end-of-task signal is `eventType: "completion"` (`swarm-events-shared.ts:208`).

The codebase already exposes a worker-safe alternative — `runMemoryRater()` in `src/be/memory/raters/llm-summarizer.ts:134` — that is exactly what claude's hook uses. It calls OpenRouter directly via `fetch`, depends only on `OPENROUTER_API_KEY`, returns the same `SummaryWithRatings` schema, and does not touch `bun:sqlite` or shell out to any CLI. It is the natural drop-in replacement for the `claude -p` pipeline in pi/opencode and the missing implementation in codex.

A second, broader option also exists: `@mariozechner/pi-ai@0.73.0` is **already a dependency** (`package.json:108`) and already used by the pi adapter (`src/providers/pi-mono-adapter.ts:11` imports `getModel`). Its top-level `complete()` / `stream()` API targets 30+ providers (anthropic, openrouter, openai, opencode, mistral, google, github-copilot, codex, …) including dedicated OAuth flows for Anthropic Pro/Max, OpenAI Codex, and GitHub Copilot. A small wrapper around `pi-ai`'s `complete()` could serve as the unified summarizer for **every non-claude-OAuth worker provider** — pi, opencode, codex, devin — leaving claude on its existing OpenRouter `runMemoryRater` path (or eventually subsuming that too). Details in [§Discovery: pi-ai as the unified internal AI wrapper](#discovery-pi-ai-as-the-unified-internal-ai-wrapper).

## Reviewer-Driven Updates (2026-05-10 file-review pass)

After Taras reviewed the first draft, six comments were left. Quick answers:

1. **"Research pi-mono SDKs / low-level AI package"** — Done. `@mariozechner/pi-ai` is already a dep and partially used. Full surface and integration plan in [§Discovery: pi-ai as the unified internal AI wrapper](#discovery-pi-ai-as-the-unified-internal-ai-wrapper).
2. **"Build a tiny internal AI wrapper using pi-ai for ALL providers excluding claude OAuth, then map default models per provider"** — Confirmed feasible. The wrapper would import `complete` + `getModel` + `getEnvApiKey` from `@mariozechner/pi-ai`, plus `getOAuthApiKey` for the OAuth providers. Sketch in [§Discovery → Proposed shape](#proposed-shape-of-the-internal-wrapper).
3. **"`if (!process.env.SKIP_SESSION_SUMMARY)` — if the env is not set, will it fire?"** — **Yes.** When `SKIP_SESSION_SUMMARY` is unset, `process.env.SKIP_SESSION_SUMMARY` is `undefined`, `!undefined` is `true`, so the block runs. Default behavior is "summarize on session end"; `SKIP_SESSION_SUMMARY=1` opts out. (Same pattern in pi: `pi-mono-extension.ts:663`, and in claude: `hook.ts:1089`.)
4. **"Codex has no SessionEnd hook — we should add it"** — Agreed and proposed. See [Codex: build the missing path adapter-side](#codex-build-the-missing-path-adapter-side) — implementation has to be adapter-side because codex has no harness-side hook surface upstream. Inline note now added at line 186.
5. **"`LlmRater` and `ClaudeCliLlmRaterClient` — are they wrong too? Or do they run on the API node?"** — **Neither.** They are constructed on the API server but **never invoked in production**: `LlmRater` is filtered out of `SERVER_RATERS` (`src/be/memory/raters/registry.ts:43` lists only `"implicit-citation"`), and `getDefaultLlmRaterClient()` (`llm-client.ts:164`) has zero production importers. The classes exist but are reachable only through tests and a path that's currently disabled. The previous draft mis-classified them as "API-server-only and assumed-working"; the corrected classification is "**dead code in production**, kept for tests + interface symmetry". The "Available alternatives" section below has been rewritten to reflect this.
6. **"Each provider could have different auths"** — Exactly the constraint that justifies a unified wrapper. `pi-ai` already encapsulates per-provider auth via `getEnvApiKey(provider)` + `getOAuthApiKey(providerId, credentials)`, so the wrapper can dispatch on `Model.provider` and resolve the correct credential without per-provider conditionals in the calling code. Open Question 1 has been extended below.

## Detailed Findings

### Claude — working baseline

Claude is the only provider where session summarization actually runs reliably end-to-end.

**Hook wiring**:
- `plugin/hooks/hooks.json:59-69` registers a single shell hook for every Claude Code lifecycle event (including `Stop`); each invocation runs `bunx @desplega.ai/agent-swarm@latest hook`.
- `src/providers/claude-adapter.ts:191-205` spawns the `claude` CLI and plumbs `TASK_FILE` / `AGENT_SWARM_TASK_ID` / `AGENT_SWARM_AGENT_ID` env vars so the Stop hook can recover task identity.
- The `hook` CLI dispatches on the `hook_event_name` field that Claude Code pipes on stdin; the `Stop` branch is `src/hooks/hook.ts:1043`.

**Stop-handler implementation** (`src/hooks/hook.ts:1043-1222`):
- Gate (lines 1089-1094): requires `agentInfo?.id`, `msg.transcript_path`, no `SKIP_SESSION_SUMMARY`, AND `OPENROUTER_API_KEY`. No OpenRouter key ⇒ summarization skipped silently.
- Reads transcript from the path Claude Code supplied; keeps last 20 KB (lines 1098-1100).
- If `MEMORY_RATERS` includes `llm`, fetches existing memories for the task via `fetchRetrievalsForTask()` (line 1126), dedupes them (line 1129).
- Builds prompt: `baseSummarizePrompt` literal (lines 1132-1149) → wrapped via `buildSummaryWithRatingsPrompt(baseSummarizePrompt, retrievals)` (line 1155) which appends retrievals + the JSON-schema instructions.
- Calls `runMemoryRater({ prompt, apiKey: OPENROUTER_API_KEY })` (line 1157).

**Model invocation layer**:
- `runMemoryRater` (`src/be/memory/raters/llm-summarizer.ts:134-201`) does a direct `fetch` POST to `https://openrouter.ai/api/v1/chat/completions` with `response_format: { type: "json_schema", … }` and `MEMORY_RATER_MODEL` (default `google/gemini-3-flash-preview`, `llm-summarizer.ts:21`, `:53-57`).
- **No shellout to any CLI**, no Anthropic SDK call, no `bun:sqlite`. Pure `fetch`, worker-safe, runs inside the Stop hook subprocess.

**Persistence** (`src/hooks/hook.ts:1176-1214`):
- POST `${MCP_BASE_URL}/api/memory/index` with `Authorization: Bearer ${API_KEY}` and `X-Agent-ID`, body `{ source: "session_summary", scope: "agent", sourceTaskId, content: summary, … }`.
- Skipped when summary is empty / shorter than 20 chars / contains "no significant learnings" (lines 1171-1175).
- Per-memory ratings POSTed via `postRatings()` after `buildRatingsFromLlm(ratings, retrievals)` — best-effort, does not block the index POST.

### Pi — `summarizeSession` exists but the LLM call usually fails

**Where it lives** (`src/providers/pi-mono-extension.ts`):
- `summarizeSession(config, sessionFile)` defined at line 280.
- Called from the `session_shutdown` handler at line 664. `session_shutdown` is registered at line 640 inside `createSwarmHooksExtension` (line 384), which is loaded into pi via `DefaultResourceLoader({ extensionFactories: [swarmExtension] })` in `src/providers/pi-mono-adapter.ts:582-587`, then consumed by `createAgentSession` at line 598. This is pi-mono's native equivalent of Claude's `Stop`.
- Caller (`pi-mono-extension.ts:639-672`): runs `final` context-usage POST (`eventType: "completion"`), `syncIdentityFilesToServer`, `syncSetupScriptToServer`, then `const sessionFile = ctx.sessionManager.getSessionFile?.()` (line 662), then `await summarizeSession(config, sessionFile)` gated on `!process.env.SKIP_SESSION_SUMMARY` (lines 663-665), then `fireAndForget POST /close`.

**Function body walkthrough** (`pi-mono-extension.ts:280-376`):
1. Line 284: early return if `sessionFile` is undefined.
2. Lines 287-293: `Bun.file(sessionFile).text()`, truncate to last 20 000 chars, return silently on read error.
3. Line 295: return if `transcript.length <= 100`.
4. Lines 297-305: `fetchTaskDetails(config)` (GET `/api/tasks/<taskId>`) for task context; errors swallowed.
5. Lines 307-324: hard-coded `summarizePrompt` (instructions + optional task line + raw transcript).
6. Lines 326-327: write prompt to `/tmp/session-summary-<Date.now()>.txt`.
7. **Lines 328-339 — the broken shellout**: `Bun.spawn(["bash", "-c", `cat "${tmpFile}" | ${process.env.CLAUDE_BINARY || "claude"} -p --model haiku --output-format json`])`. `stderr: "pipe"` but never read. `env` extends with `SKIP_SESSION_SUMMARY: "1"` (re-entrancy guard).
8. Lines 340-342: 30 s `setTimeout` calling `proc.kill()`. Only stdout collected (`new Response(proc.stdout).text()`); exit code never inspected.
9. Line 343: `Bun.$\`rm -f ${tmpFile}\`.quiet()`.
10. Lines 345-351: `JSON.parse(result.stdout).result`; falls back to raw stdout on parse failure.
11. Lines 353-357: gates on `summary.length > 20` and `!summary.toLowerCase().includes("no significant learnings")`.
12. Lines 358-371: POST `${apiUrl}/api/memory/index` `{ scope: "agent", source: "session_summary", sourceTaskId, content, name, agentId }`.
13. Lines 373-375: outer `try { … } catch { /* non-blocking */ }` swallows everything.

**The CLAUDE_BINARY default** (line 332):
```ts
`cat "${tmpFile}" | ${process.env.CLAUDE_BINARY || "claude"} -p --model haiku --output-format json`,
```
- Default when env unset: bare `"claude"`.
- Repo-wide search for `CLAUDE_BINARY` finds it in `docker-entrypoint.sh:192` (claude-branch CLI verification, gated by `[ "$HARNESS_PROVIDER" != "pi" ]` at line 191), `src/providers/claude-adapter.ts:543-544`, and the opencode plugin. **Nothing sets `CLAUDE_BINARY` in the pi runtime path.**
- However: `Dockerfile.worker:82-86` installs `@anthropic-ai/claude-code` globally for all providers (one image serves all harnesses), so `claude` IS on PATH inside the pi worker container. The pi binary-existence check at `docker-entrypoint.sh:191-204` is just *skipped* for pi, but the binary itself ships.
- The real failure mode is **auth**, not binary presence: pi sessions typically authenticate via `OPENROUTER_API_KEY` or pi's own `auth.json` (`src/providers/pi-mono-adapter.ts:75-107`), neither of which the bare `claude -p` invocation knows about. Without `ANTHROPIC_API_KEY` (or a Claude OAuth token in `~/.claude.json`), the shellout fails at auth.

**Failure mode** (default pi install):
- `Bun.spawn` does not throw on missing-binary or auth errors; bash prints to stderr (which is piped but never read).
- `proc.exitCode` never inspected.
- `result.stdout` is empty.
- `JSON.parse("")` throws → caught at line 349 → `summary = ""`.
- Length gate at line 353 fails → memory POST skipped.
- Outer catch at line 373 swallows. `session_shutdown` continues normally with `/close` and the session terminates with exit code 0 — **no learnings persisted, no log line indicating it failed**.

**What pi has available that's not used**:
- The pi extension already speaks to the swarm API extensively: `/ping`, `/cancelled-tasks`, `/me`, `/api/tasks/{id}`, `/api/agents/{id}/profile`, `/api/memory/index`, `/api/concurrent-context`, `/api/active-sessions/heartbeat/{id}`, `/api/agents/{id}/activity`, `/api/tasks/{id}/context`, `/close` (lines 31-277, 389-672).
- It has `McpHttpClient` (`src/providers/pi-mono-mcp-client.ts:20`) for JSON-RPC calls to `${apiUrl}/mcp`.
- The worker image has `bun` + node + typescript at runtime, so `runMemoryRater` (a pure `fetch` helper) is callable directly without any CLI dependency.

### Opencode — `summarizeSession` is dead code

**Where it lives** (`plugin/opencode-plugins/agent-swarm.ts`):
- `summarizeSession(config, sessionFile)` defined at line 236.
- Invoked at line 369 inside the `session.idle` event handler (the opencode-plugin equivalent of session-end), wired through the default-export `Plugin` object (lines 334-450).
- The plugin is loaded by opencode because `src/providers/opencode-adapter.ts:476` writes `plugin: [pluginPath]` into the per-task opencode config and passes it to `createOpencode` at line 513 (also written to `OPENCODE_CONFIG` env at line 505).

**The "no-op" comment at line 367** (lines 362-377):
```ts
if (event.type === "session.idle") {
  // Final identity sync
  await syncIdentityFilesToServer(config);

  // Session summary — opencode does not expose a transcript file path,
  // so summarizeSession is a no-op here (sessionFile = undefined).
  if (!process.env.SKIP_SESSION_SUMMARY) {
    void summarizeSession(config, undefined);
  }

  // Notify server session is closing
  fireAndForget(`${config.apiUrl}/api/sessions/${event.properties.sessionID}/close`, {
    method: "POST",
    headers: apiHeaders(config),
  });
}
```

The first statement of the function body (`agent-swarm.ts:240`) is `if (!sessionFile) return;`. Since `summarizeSession(config, undefined)` is the only call site, the entire body — lines 242-331, including the `claude` shellout at line 288 — is **unreachable dead code in production today**.

**Function body** (lines 236-332): byte-for-byte parallel to pi's, with the same shellout at line 288 (`cat "${tmpFile}" | ${process.env.CLAUDE_BINARY || "claude"} -p --model haiku --output-format json`) and the same `/api/memory/index` POST at line 314.

**Opencode runtime check**:
- `Dockerfile.worker:125-135` installs the opencode CLI + SDK at `/home/worker/.opencode/bin`.
- `Dockerfile.worker:244-252` copies the swarm plugin and sets `OPENCODE_SWARM_PLUGIN_PATH`. **No `CLAUDE_BINARY` set.**
- `docker-entrypoint.sh:183-204`: when `HARNESS_PROVIDER=opencode`, only `OPENCODE_BINARY` is verified (lines 184-190); the `CLAUDE_BINARY` reachability check at lines 192-203 sits in the `elif [ "$HARNESS_PROVIDER" != "pi" ]` branch and is skipped for opencode (it's executed only for the claude branch).
- The `claude` binary IS bundled in the same shared worker image (Dockerfile.worker:82-86), so it is technically on PATH for opencode workers — but again, only the binary, not the auth, and in any case the shellout never executes because of the dead-code situation.

**Hook surface opencode plugin already uses** (lines 334-450):
- `event:` handler (lines 339-378) — filters by `event.type` for `"file.edited"` (line 340) and `"session.idle"` (line 362).
- `tool.execute.before` (line 381), `tool.execute.after` (line 408), `experimental.chat.system.transform` (line 418), `experimental.session.compacting` (line 427).
- HTTP calls already used: `apiHeaders` / `fireAndForget`, `isTaskCancelled`, `checkShouldBlockPolling`, `fetchTaskDetails`, `syncIdentityFilesToServer`, `autoIndexMemoryFile`, `fetchConcurrentContext`, the `summarizeSession`'s own POST to `/api/memory/index`, and the `/api/sessions/:id/close` POST.

**Net effect today**:
At end of an opencode session, `session.idle` runs `syncIdentityFilesToServer`, calls `summarizeSession(config, undefined)` which immediately returns at line 240, then fires `/api/sessions/:sessionID/close`. **No summary prompt is built, no `/tmp/session-summary-*.txt` is written, the `claude -p` shellout never executes, no `session_summary` memory is indexed.** The "claude not in opencode runtime" risk is theoretical — the bug exists in the source but is masked by the dead-code condition.

### Codex — no session-summarization implementation at all

**Adapter-side hooks** (what codex actually runs, `src/providers/codex-adapter.ts:17`, `:394-398`, dispatched through `createCodexSwarmEventHandler` at `src/providers/codex-swarm-events.ts:38-45` → `src/providers/swarm-events-shared.ts:94-262`):
- `session_init` — caches session id (`swarm-events-shared.ts:224-227`).
- `tool_start` (fires on each `item.started` for command/file_change/mcp_tool_call/web_search per `codex-adapter.ts:577-587`):
  - `checkCancelled` — throttled 500 ms poll of `GET /cancelled-tasks?taskId=...`; aborts on hit (lines 107-135, 228-231).
  - `checkLoop` — invokes `checkToolLoop` from `src/hooks/tool-loop-detection.ts`; aborts on `result.blocked` (lines 137-148, 232).
  - `heartbeat` — throttled 5 s `PUT /api/active-sessions/heartbeat/<taskId>` (lines 150-157, 233).
  - `activity` — throttled 5 s `PUT /api/agents/<agentId>/activity` (lines 159-166, 234).
- `context_usage` → throttled 30 s `POST /api/tasks/<taskId>/context` `eventType: "progress"` (lines 168-186, 237-243). Emitted from `turn.completed` at `codex-adapter.ts:669-705`.
- `compaction` → `eventType: "compaction"` POST (lines 188-206, 245-251). **Never emitted by codex** — codex has no auto-compaction (see `codex-adapter.ts:719-748`).
- `result` → `eventType: "completion"` POST (lines 208-219, 253-256). Fired from `runSession` at `codex-adapter.ts:803-808`, `:820-821`.

**No `summarizeSession` / SessionEnd hook exists.** The `eventType: "completion"` POST carries no transcript and no summary. Adding one is part of the proposed fix below — see [Codex: build the missing path adapter-side](#codex-build-the-missing-path-adapter-side).

**Harness-side hooks** (the `src/hooks/hook.ts` mechanism that claude uses):
- Claude implements `SessionStart` (line 742), `PreToolUse` (line 844), `PostToolUse` (line 907), `UserPromptSubmit` (line 1032), `Stop` (line 1043). These are registered through Claude Code's native settings.json hook system, referenced at `docker-entrypoint.sh:525-539`.
- **Codex has no equivalent.** Searches across `src/providers/codex-adapter.ts`, `codex-agents-md.ts`, `codex-skill-resolver.ts`, `codex-swarm-events.ts`, and the codex branch of `docker-entrypoint.sh:86-156`, `:170-177` find no codex-side hook configuration of any kind.
- `buildCodexConfig` (`codex-adapter.ts:230-341`) writes only `model`, `approval_policy`, `sandbox_mode`, `skip_git_repo_check`, `show_raw_agent_reasoning`, `mcp_servers`. No hook keys.
- The only injection point into codex is the `<swarm_system_prompt>` block inside `AGENTS.md` (`codex-agents-md.ts:38-96`). That is prompt content, not a hook.
- No code path in this repo configures or asserts that codex (the upstream CLI) supports PreToolUse / PostToolUse / SessionEnd-style hooks at all.

**Hook comparison table**:

| Claude hook | Claude location | Codex equivalent |
|---|---|---|
| `SessionStart` | `src/hooks/hook.ts:742` | None |
| `UserPromptSubmit` | `src/hooks/hook.ts:1032` | None (skill-resolver at `codex-skill-resolver.ts:62` rewrites prompts before `thread.runStreamed`, but it's not a hook callback) |
| `PreToolUse` | `src/hooks/hook.ts:844` | Adapter-side `tool_start` listener (non-blocking; `codex-swarm-events.ts:20-22`) |
| `PostToolUse` | `src/hooks/hook.ts:907` | None — codex emits `tool_end` (`codex-adapter.ts:609-619`) but no listener acts on it (`swarm-events-shared.ts:221-257` has no `tool_end` case) |
| `Stop` / SessionEnd (memory rater + summary) | `src/hooks/hook.ts:1043, 1089-1230` | None |

**Memory/learnings impact for codex**:
- Codex's `runSession` finally-block (`codex-adapter.ts:829-838`) flushes the log writer, cleans up `AGENTS.md`, detaches the abort controller — no rater, no transcript summarization, no `/api/memory/index` POST.
- `src/be/memory/raters/`, `src/tools/store-progress.ts`, `src/commands/runner.ts` contain no codex-specific post-task summarizer paths (`grep "codex" src/be/memory` returns zero matches).

**Net effect today**: Session summarization and learning extraction simply do not happen at the end of a codex task. The only end-of-task signal is the `eventType: "completion"` POST at `swarm-events-shared.ts:208-219`.

### Available alternatives in the codebase

These are the existing, worker-reachable summarization paths the broken/missing implementations could rely on. Classification follows the architecture invariant in `CLAUDE.md`: workers MUST NOT touch `bun:sqlite`; they go over HTTP with `API_KEY` + `X-Agent-ID`. **Important correction from Taras's review**: two of the rater abstractions in `src/be/memory/raters/` are **dead code in production** — see "Currently dead code" below.

**Building blocks (no LLM call, pure helpers)** — `src/be/memory/raters/llm.ts`:
- `buildSummaryWithRatingsPrompt(basePrompt, retrievals)` — line 179 — appends retrieval rows + JSON-schema instructions to a base prompt. **Live**, used by claude's Stop hook (`hook.ts:1155`).
- `buildRatingsFromLlm(...)` — line 135 — converts validated LLM JSON into `RatingEvent[]`. **Live**, used by `hook.ts:1203`.
- `SummaryWithRatingsSchema` — line 52 — zod schema for `{ summary, ratings[] }`. **Live**.
- `fetchRetrievalsForTask(...)` — line 300, `postRatings(...)` — line 335 — HTTP helpers. **Live**, used by the Stop hook.
- `LlmRater` class — line 70 — `MemoryRater` impl that delegates to an `LlmRaterClient`. **DEAD CODE in production**: filtered out of `SERVER_RATERS` (`src/be/memory/raters/registry.ts:43` only registers `"implicit-citation"`); `LlmRater.rate()` is reachable in tests only (`src/tests/memory-rater-llm.test.ts`). Constructor still gets called when `MEMORY_RATERS` env contains `llm` (via `registry.ts:32`), but the rater is then dropped at `run-server-raters.ts:75` before `.rate()` runs. The class header comment at `llm.ts:6-14` documents this explicitly.

**Direct OpenRouter caller (worker-safe)** — `src/be/memory/raters/llm-summarizer.ts`:
- `runMemoryRater(opts)` — line 134 — calls `https://openrouter.ai/api/v1/chat/completions` with `response_format: json_schema`, returns parsed `SummaryWithRatings`. Raw `fetch`, no DB. JSDoc explicitly says "Worker-safe."
- `getMemoryRaterModel(env)` — line 53 — resolves `MEMORY_RATER_MODEL` (default `google/gemini-3-flash-preview`).
- **Live**, sole production callsite is `src/hooks/hook.ts:1157` (claude's Stop hook). The API server itself does NOT call this — there is no codex/devin completion-handler that triggers it server-side.

**Currently dead code (kept for tests + interface symmetry)** — `src/be/memory/raters/llm-client.ts`:
- `ClaudeCliLlmRaterClient` — line 111 — wraps the same `Bun.spawn → claude -p --model haiku --output-format json` pattern (line 128) as the pi/opencode inline copies. **DEAD**: only instantiated as the default constructor argument to `LlmRater` (`llm.ts:73`); `LlmRater.rate()` never runs in production (see above), so this client never executes either.
- `getDefaultLlmRaterClient()` — line 164 — keyed by `MEMORY_LLM_RATER_PROVIDER` env, defaulting to `"claude-cli"`. **DEAD**: zero production importers (grep finds only the definition file). Any non-`"claude-cli"` value warns and still falls back to `ClaudeCliLlmRaterClient`.
- These two were the same `claude -p` shellout pattern that CHANGELOG #450 (2026-05-?? entry) replaced for the **claude Stop hook** when Anthropic's CLI bump (2.1.112 → 2.1.126) stopped propagating `CLAUDE_CODE_OAUTH_TOKEN` to subprocesses ("0 LLM rater rows ever, 417 garbage session-summary rows over 2 days"). The fix migrated the Stop hook to OpenRouter via `runMemoryRater`, but the `llm-client.ts` shellout abstraction was left in place, alongside the two surviving inline copies in `pi-mono-extension.ts:332` and `agent-swarm.ts:288`.

**Memory HTTP endpoints (auth-gated, worker-callable)** — all `src/http/memory.ts`, registered via `route()`:
- `POST /api/memory/index` (line 23) — queue text for embedding.
- `POST /api/memory/search` (line 45).
- `POST /api/memory/re-embed` (line 62).
- `POST /api/memory/list` (line 82).
- `DELETE /api/memory/{id}` (line 114).
- `POST /api/memory/rate` (line 169) — accepts pre-computed rating events; **does NOT itself summarize**.
- `GET /api/memory/retrievals` (line 186).
- `GET /api/memory/edges` (line 211).

**No `/summarize`, `/llm/*`, or any HTTP endpoint that runs an LLM completion on behalf of a worker exists.** Workers must call an LLM provider directly.

**MCP tools** (`src/tools/`):
- `memory_search` (`memory-search.ts:11`), `memory_rate` (`memory-rate.ts:32`), `memory_get` / `memory_delete` — none summarize.
- `store_progress` (`store-progress.ts:54`) — stores progress + status; fires server-side raters via `POST /api/memory/rate` (line 391) but does not itself call an LLM. The `runServerRaters` it triggers (`store-progress.ts:383`) only runs `"implicit-citation"`, NOT `LlmRater`.
- **No `summarize_session` MCP tool exists.**

**LLM clients elsewhere**:
- `@mariozechner/pi-ai` — `package.json:108`, version `^0.73.0` — **already a dep, partially used**. `src/providers/pi-mono-adapter.ts:11` imports `getModel` only; the rest of the surface (`complete`, `stream`, `getEnvApiKey`, `getOAuthApiKey`, etc.) is unused. Worker-safe (no `bun:sqlite` coupling). Full inventory in [§Discovery: pi-ai as the unified internal AI wrapper](#discovery-pi-ai-as-the-unified-internal-ai-wrapper).
- `@mariozechner/pi-coding-agent` — pi-mono SDK proper; brings `AuthStorage` for `~/.pi/agent/auth.json`.
- `src/workflows/executors/raw-llm.ts:21` — `RawLlmExecutor` uses `@ai-sdk/openai` `createOpenAI({ baseURL: "https://openrouter.ai/api/v1" })` + `generateText`/`generateObject`. **API-server-only** (workflow executor).
- `src/workflows/executors/validate.ts:117` — same pattern. API-server-only.
- `src/commands/claude-managed-setup.ts:483` — `new Anthropic({ apiKey })` for managed-agent setup. Worker-side, one-off setup only.

**Priority order for replacing the broken paths** (revised after pi-ai discovery):
1. **A pi-ai-based wrapper** (`complete()` from `@mariozechner/pi-ai/dist/stream`). Per-provider model + auth, covers pi/opencode/codex/devin in one helper. Recommended approach — see [§Discovery](#discovery-pi-ai-as-the-unified-internal-ai-wrapper).
2. **`runMemoryRater`** (`llm-summarizer.ts:134`) — minimal-change drop-in for pi-mono-extension and the opencode plugin if we don't want a new module. Hardcoded to OpenRouter; still leaves codex needing a separate path.
3. The `@ai-sdk/openai` + OpenRouter pattern from `raw-llm.ts:39` if a free-form non-rater summary is wanted.
4. None of the existing HTTP endpoints or MCP tools can do this server-side; the worker has to call an LLM provider directly.

## Discovery: pi-ai as the unified internal AI wrapper

This section is the answer to Taras's review comments 1, 2, and 6. **`@mariozechner/pi-ai`** is already a project dependency (`package.json:108`, `^0.73.0`), already partially used by the pi adapter, and exposes exactly the abstractions needed to converge pi / opencode / codex / devin onto a single per-provider-aware summarizer call. Claude with user OAuth keeps its existing path (`claude -p` via Anthropic's CLI hook, which now routes through `runMemoryRater` post-#450).

### What pi-ai exposes

Top-level subpath exports from `node_modules/@mariozechner/pi-ai/dist/index.d.ts`:

- **`./stream`** (`dist/stream.d.ts:4-7`)
  - `complete(model, context, options) → Promise<AssistantMessage>` — one-shot non-streaming call. This is what we'd use for summarization.
  - `stream(...)` — streaming variant (not needed for summarize).
  - `completeSimple` / `streamSimple` — convenience wrappers that take just a string prompt.
- **`./models`** (`dist/models.d.ts:6-16`)
  - `getModel(provider, modelId) → Model` — already imported at `src/providers/pi-mono-adapter.ts:11` and used at `:153, :166, :175` for model resolution.
  - `getProviders()`, `getModels()`, `calculateCost()`, `getSupportedThinkingLevels()`, `clampThinkingLevel()`, `modelsAreEqual()`.
- **`./types`** (`dist/types.d.ts`)
  - `Context { systemPrompt?, messages: Message[], tools? }` (line 167-173).
  - `Message = UserMessage | AssistantMessage | ToolResultMessage` (line 174-178).
  - `Tool<TParameters extends TSchema>` (line 124-137) — uses **typebox** schemas.
  - `Usage` with `cost` field (line 380-404).
- **`./env-api-keys`** (`dist/env-api-keys.d.ts:9-17`)
  - `findEnvKeys(provider)` / `getEnvApiKey(provider)` — env-var-only credential resolution.
- **`./oauth`** (`dist/oauth.d.ts:1` → `dist/utils/oauth/index.d.ts:9-56`)
  - `loginAnthropic()`, `refreshAnthropicToken()`, `anthropicOAuthProvider`.
  - `loginOpenAICodex()`, `refreshOpenAICodexToken()`, `openaiCodexOAuthProvider`.
  - `loginGitHubCopilot()`, `refreshGitHubCopilotToken()`, `githubCopilotOAuthProvider`.
  - `getOAuthProvider`, `getOAuthApiKey(providerId, credentials) → string`, `registerOAuthProvider`.
  - `OAuthCredentials = { refresh, access, expires, ... }` (`dist/utils/oauth/types.d.ts:2-7`).
- **`./api-registry`** — register custom API providers.
- **Provider subpaths** (`./anthropic`, `./google`, `./openai-completions`, `./openai-responses`, `./mistral`, `./bedrock-provider`, `./azure-openai-responses`, `./google-vertex`, `./openai-codex-responses`).

`KnownProvider` enum (`dist/types.d.ts:6`) covers: `anthropic`, `openrouter`, `openai`, `google`, `google-vertex`, `azure-openai-responses`, `openai-codex`, `deepseek`, `github-copilot`, `xai`, `groq`, `cerebras`, `vercel-ai-gateway`, `zai`, `mistral`, `minimax`, `moonshotai`, `huggingface`, `fireworks`, **`opencode`**, `opencode-go`, `kimi-coding`, `cloudflare-workers-ai`, `cloudflare-ai-gateway`, `xiaomi`, `amazon-bedrock`. Note: `pi`'s hosted endpoint is not a distinct provider — pi-ai targets upstream APIs directly.

### How pi-mono uses it today

- `src/providers/pi-mono-adapter.ts:11` — `import { getModel } from "@mariozechner/pi-ai";`
- `src/providers/pi-mono-adapter.ts:153, 166, 175` — `resolveModel(modelStr)` calls `getModel(...)` to turn shortnames (`opus`/`sonnet`/`haiku`) and `provider/model-id` strings into a `Model` object passed into `createAgentSession`.
- `src/providers/pi-mono-adapter.ts:18-24` — uses `@mariozechner/pi-coding-agent` (a separate, higher-level package) for the agent session machinery itself; that package is the one that reads `~/.pi/agent/auth.json` via its `AuthStorage` class.

That's it. `complete`, `stream`, `getEnvApiKey`, `getOAuthApiKey`, and the OAuth login flows are all unused.

### Credential reality per provider

This is the fact pattern that justifies the unified wrapper (review comment 6 — "each provider could have different auths"):

| Provider | Auth source today | pi-ai resolver |
|---|---|---|
| **claude** (CLI w/ user OAuth) | `~/.claude.json` OAuth token, propagated as `CLAUDE_CODE_OAUTH_TOKEN` to subprocesses | **Skip** — keep on `claude -p` (the user's UI tokens) |
| **claude** (with `ANTHROPIC_API_KEY`) | `ANTHROPIC_API_KEY` env | `getEnvApiKey("anthropic")` |
| **pi** | `~/.pi/agent/auth.json` (`pi-mono-adapter.ts:81-84`) OR `MODEL_OVERRIDE`-keyed env (`:46-64, :86-96`) OR generic `OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` (`:99-101`) | `getEnvApiKey(...)` for env vars; `~/.pi/agent/auth.json` is read by `pi-coding-agent`'s `AuthStorage`, NOT by pi-ai itself |
| **opencode** | `OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `~/.local/share/opencode/auth.json` (`docker-entrypoint.sh` opencode credential branch — see CHANGELOG entry for DES-302 / #407) | `getEnvApiKey(...)` for env vars; opencode's `auth.json` would need a small adapter |
| **codex** | OpenAI Codex OAuth (`thoughts/taras/plans/2026-04-10-codex-oauth-support.md`) and/or `OPENAI_API_KEY` | `getOAuthApiKey("openai-codex", credentials)` for OAuth; `getEnvApiKey("openai")` for API key |
| **devin** | API key for the Devin platform | Out of scope per Taras (not supported) |

The wrapper would dispatch on `Model.provider` (returned by `getModel`) to pick the resolver.

### Proposed shape of the internal wrapper

A new module — sketch only, not yet written — somewhere like `src/utils/internal-ai.ts` (or `src/be/memory/raters/internal-ai.ts` if we want it co-located with the rater code; it would NOT touch `bun:sqlite` either way, so the architecture invariant is satisfied):

```ts
import { getModel, complete, getEnvApiKey } from "@mariozechner/pi-ai";
import { getOAuthApiKey } from "@mariozechner/pi-ai/oauth";
import type { Context, Model } from "@mariozechner/pi-ai/types";

// Per-harness defaults; override via MODEL_OVERRIDE / MEMORY_RATER_MODEL.
const DEFAULT_MODEL: Record<HarnessProvider, string> = {
  pi:        "openrouter/google/gemini-3-flash-preview",
  opencode:  "openrouter/google/gemini-3-flash-preview",
  codex:     "openai-codex/gpt-5-mini",   // or fall back to openrouter
  devin:     "openrouter/google/gemini-3-flash-preview",
  // claude (OAuth) intentionally excluded — uses claude -p via existing hook
};

export async function summarizeWithInternalAi(opts: {
  harness: HarnessProvider;
  systemPrompt: string;
  userPrompt: string;
}): Promise<string> {
  const modelStr = process.env.MEMORY_RATER_MODEL ?? DEFAULT_MODEL[opts.harness];
  const model = getModel(...parseModelStr(modelStr));
  const apiKey = await resolveApiKey(model, opts.harness);  // env -> OAuth -> auth.json
  if (!apiKey) return "";  // graceful no-op, just like claude's hook does today

  const ctx: Context = {
    systemPrompt: opts.systemPrompt,
    messages: [{ role: "user", content: opts.userPrompt }],
  };
  const msg = await complete(model, ctx, { apiKey });
  return extractText(msg);
}
```

`resolveApiKey(model, harness)` would be the per-provider dispatcher: try `getEnvApiKey(model.provider)` first, fall back to harness-specific paths (`~/.pi/agent/auth.json` for pi via `pi-coding-agent`'s `AuthStorage`; `~/.local/share/opencode/auth.json` for opencode; `getOAuthApiKey("openai-codex", ...)` for codex OAuth tokens stored in the swarm DB).

### What stays out of scope for the wrapper

- **Claude with user OAuth (`HARNESS_PROVIDER=claude`)**: Per Taras's instruction, this stays on `claude -p`. The user's Pro/Max OAuth tokens (`CLAUDE_CODE_OAUTH_TOKEN`) flow through Anthropic's CLI; no Anthropic API key. The current `runMemoryRater` path (`hook.ts:1157`) already calls OpenRouter — that's a separate question (does claude's hook get migrated to pi-ai? probably yes, eventually, since pi-ai supports OpenRouter natively, but it's not blocking the pi/opencode/codex fix).
- **The dead `LlmRater` / `ClaudeCliLlmRaterClient`**: They were the casualty of CHANGELOG #450 but never deleted. Cleanup is independent of the wrapper work and could happen in the same PR.
- **The API-server LLM clients** (`raw-llm.ts`, `validate.ts`): Different use-case (workflow execution), already working via `@ai-sdk/openai`. Out of scope unless we want a single LLM client across the codebase.

### Schema-validated output

Pi-ai's `complete()` returns a free-form `AssistantMessage`, not a JSON-schema-constrained object. To get the same `{summary, ratings[]}` structure that `runMemoryRater` produces today (zod-validated via `SummaryWithRatingsSchema`), we'd either:
- Pass a tool definition (`Tool<TSchema>`) to `complete()` and have the model call the tool — pi-ai supports this, but it's heavier-weight.
- Keep the prompt-engineered "respond with JSON only" approach, then `JSON.parse` the result and run it through `SummaryWithRatingsSchema.parse()` ourselves. Same as today's claude shellout, just with pi-ai instead of `Bun.spawn`.

Either works. Detail to settle in the implementation plan.

## Code References

| File | Line | Description |
|---|---|---|
| `src/hooks/hook.ts` | 1043 | Claude's `Stop` branch entry point |
| `src/hooks/hook.ts` | 1089-1094 | Gate: requires `OPENROUTER_API_KEY` |
| `src/hooks/hook.ts` | 1132-1149 | `baseSummarizePrompt` literal |
| `src/hooks/hook.ts` | 1155 | `buildSummaryWithRatingsPrompt(...)` |
| `src/hooks/hook.ts` | 1157 | `runMemoryRater(...)` call |
| `src/hooks/hook.ts` | 1176-1193 | POST `/api/memory/index` `source: "session_summary"` |
| `src/be/memory/raters/llm-summarizer.ts` | 134 | `runMemoryRater` — worker-safe OpenRouter caller |
| `src/be/memory/raters/llm-summarizer.ts` | 21, 53-57 | Default model `google/gemini-3-flash-preview` |
| `src/be/memory/raters/llm.ts` | 52 | `SummaryWithRatingsSchema` |
| `src/be/memory/raters/llm.ts` | 179 | `buildSummaryWithRatingsPrompt` |
| `src/be/memory/raters/llm-client.ts` | 111 | `ClaudeCliLlmRaterClient` (DEAD CODE — same `claude -p` shellout, never invoked) |
| `src/be/memory/raters/llm-client.ts` | 164 | `getDefaultLlmRaterClient()` keyed by `MEMORY_LLM_RATER_PROVIDER` (DEAD — zero importers) |
| `src/be/memory/raters/llm.ts` | 70-73 | `LlmRater` class (DEAD — filtered out of `SERVER_RATERS`) |
| `src/be/memory/raters/registry.ts` | 32, 43 | `SERVER_RATERS = {"implicit-citation"}` filter (excludes `LlmRater`) |
| `src/be/memory/raters/run-server-raters.ts` | 75 | Filter that drops non-server raters before `.rate()` runs |
| `package.json` | 108 | `@mariozechner/pi-ai@^0.73.0` declared as dep |
| `node_modules/@mariozechner/pi-ai/dist/stream.d.ts` | 4-7 | `complete()` / `stream()` exports |
| `node_modules/@mariozechner/pi-ai/dist/models.d.ts` | 6-16 | `getModel()` / `getProviders()` / `calculateCost()` |
| `node_modules/@mariozechner/pi-ai/dist/env-api-keys.d.ts` | 9-17 | `getEnvApiKey(provider)` env-based credential resolver |
| `node_modules/@mariozechner/pi-ai/dist/utils/oauth/index.d.ts` | 9-56 | Anthropic / OpenAI Codex / GitHub Copilot OAuth flows |
| `node_modules/@mariozechner/pi-ai/dist/types.d.ts` | 6 | `KnownProvider` enum (anthropic, openrouter, openai-codex, opencode, …) |
| `src/providers/pi-mono-adapter.ts` | 11, 153, 166, 175 | `getModel` from `@mariozechner/pi-ai` (only pi-ai usage in repo) |
| `src/providers/pi-mono-adapter.ts` | 75-107 | `checkPiMonoCredentials` — current per-provider credential resolution for pi |
| `CHANGELOG.md` | 33 | #450 entry — migration of claude Stop hook from `claude -p` to OpenRouter SDK |
| `plugin/hooks/hooks.json` | 59-69 | Claude `Stop` hook → `bunx @desplega.ai/agent-swarm hook` |
| `src/providers/claude-adapter.ts` | 191-205 | Claude CLI spawn + identity env plumbing |
| `src/providers/pi-mono-extension.ts` | 280 | Pi `summarizeSession` definition |
| `src/providers/pi-mono-extension.ts` | 332 | Pi's `claude -p --model haiku` shellout |
| `src/providers/pi-mono-extension.ts` | 640, 664 | `session_shutdown` handler invokes `summarizeSession` |
| `src/providers/pi-mono-extension.ts` | 358-371 | POST `/api/memory/index` |
| `src/providers/pi-mono-extension.ts` | 373-375 | Outer catch swallows all errors |
| `src/providers/pi-mono-adapter.ts` | 582-587, 598 | Extension wiring into `createAgentSession` |
| `plugin/opencode-plugins/agent-swarm.ts` | 236 | Opencode `summarizeSession` definition |
| `plugin/opencode-plugins/agent-swarm.ts` | 240 | `if (!sessionFile) return;` — makes function dead code |
| `plugin/opencode-plugins/agent-swarm.ts` | 288 | Opencode's `claude -p --model haiku` shellout (unreachable) |
| `plugin/opencode-plugins/agent-swarm.ts` | 367-377 | `session.idle` calls `summarizeSession(config, undefined)` |
| `src/providers/opencode-adapter.ts` | 476, 505, 513 | Plugin path written into per-task opencode config |
| `Dockerfile.worker` | 82-86 | `claude` CLI installed globally for ALL providers in the shared worker image |
| `Dockerfile.worker` | 93 | pi-mono CLI install |
| `Dockerfile.worker` | 125-135, 244-252 | opencode CLI + plugin path |
| `docker-entrypoint.sh` | 191-204 | `CLAUDE_BINARY` reachability check — gated to claude branch only |
| `src/providers/codex-adapter.ts` | 17, 394-398 | "Adapter-side swarm hooks" comments |
| `src/providers/codex-adapter.ts` | 230-341 | `buildCodexConfig` — no hook keys written |
| `src/providers/codex-adapter.ts` | 803-821 | `runSession` end — only emits `result` event, no summarize |
| `src/providers/codex-adapter.ts` | 829-838 | finally-block: log flush + AGENTS.md cleanup, no rater |
| `src/providers/codex-swarm-events.ts` | 38-45 | `createCodexSwarmEventHandler` |
| `src/providers/swarm-events-shared.ts` | 94-262 | Adapter-side event listener — cancellation/loop/heartbeat/activity/context/completion |
| `src/providers/swarm-events-shared.ts` | 208-219, 253-256 | `result` → `eventType: "completion"` POST (only end-of-task signal for codex) |
| `src/http/memory.ts` | 23, 45, 62, 82, 114, 169, 186, 211 | All `/api/memory/*` endpoints (none summarize) |
| `src/tools/store-progress.ts` | 54, 391 | Stores progress; fires raters server-side; no LLM call |

## Open Questions

These are factual gaps surfaced by the audit that may need confirmation before any fix is designed:

1. **Per-provider auth reality** (extended after Taras's review comment 6): each harness has its own credential surface. The wrapper has to handle:
   - **pi**: `~/.pi/agent/auth.json` (read by `pi-coding-agent`'s `AuthStorage`, NOT by pi-ai itself) + `MODEL_OVERRIDE`-keyed env vars (`pi-mono-adapter.ts:46-101`) + `OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`. Production deployments of `cloud.agent-swarm.dev` — which combination is actually present? Empirical check: `SELECT COUNT(*) FROM agent_memory WHERE source='session_summary' AND agentId IN (SELECT id FROM agents WHERE harness='pi')` vs total pi tasks should reveal whether the silent-fail mode is actually firing. Today's silent catch (`pi-mono-extension.ts:373-375`) makes this invisible from logs.
   - **opencode**: same env vars OR `~/.local/share/opencode/auth.json`. Confirmed via CHANGELOG DES-302 / #407 entry.
   - **codex**: OpenAI Codex OAuth (per `thoughts/taras/plans/2026-04-10-codex-oauth-support.md`) OR `OPENAI_API_KEY`. The OAuth tokens are persisted in the swarm DB; the wrapper would need to read them via the API server's existing `oauth_tokens` access path.
   - **claude (OAuth)**: stays on `claude -p`, no API key needed.
2. **`MEMORY_RATER` vs `CLAUDE_CLI` dual configuration → cleanup**: there are two separate "summarizer LLM client" abstractions in the repo — `runMemoryRater` (live, used by claude hook) and `ClaudeCliLlmRaterClient` + `getDefaultLlmRaterClient()` (DEAD CODE, see Available alternatives section). Neither is referenced by pi-mono-extension or the opencode plugin — both inline a third copy of the `Bun.spawn → claude -p` pattern. The pi-ai wrapper proposed below would replace all three; the dead `LlmRater` machinery in `llm.ts` / `llm-client.ts` could be deleted in the same PR.
3. **Codex hook capability upstream**: does the codex CLI itself expose a hook config equivalent to claude-code's `~/.claude/settings.json`? The repo doesn't use any. If the upstream CLI has none, codex summarization must be done adapter-side (around `runSession`'s finally-block at `codex-adapter.ts:829-838`) using the transcript that codex's `ProviderEvent` stream already produces.
4. **Codex transcript source**: does the codex adapter accumulate enough transcript content during `runSession` (`codex-adapter.ts:577-705`) to feed a summarizer? The `tool_start`/`tool_end`/`turn.completed`/`item.started` events go through the adapter — is the per-event content currently kept in memory or written to a file the adapter could read at `result` time? Not examined in this audit.
5. **`MEMORY_RATERS` env requirement**: claude's path gates on `MEMORY_RATERS` including `llm` for retrieval enrichment (`hook.ts:1121-1126`). If pi/opencode/codex are fixed to call the new wrapper, should they also fetch retrievals, or skip that step? Affects per-memory rating accuracy but not whether a summary gets indexed.
6. **Per-harness default model choice**: the proposed wrapper sketches per-harness defaults (`gemini-3-flash-preview` via OpenRouter for most, codex possibly through OpenAI Codex). Should we standardize on a single cheap default (Gemini 3 Flash, $0.5/M in + $3/M out per CHANGELOG #450) for all four, or let each harness pick? Cost vs simplicity trade-off.

## Proposed Solutions

**Note**: The `desplega:researching` skill defaults to documentation-only ("describe what IS, not what SHOULD BE"). Taras explicitly asked for proposals in the research request, so this section deviates from the default. Skip if you only want the audit.

After the file-review pass, the recommended approach is **a single internal AI wrapper around `@mariozechner/pi-ai`** that all four worker harnesses (pi, opencode, codex, devin) use for session summarization, leaving claude (with user OAuth) on its existing path. This consolidates three inline `Bun.spawn → claude -p` copies + two pieces of dead code into one well-tested module that already understands per-provider auth.

### Phase 0: Add the internal AI wrapper

New module `src/utils/internal-ai.ts` (or `src/be/memory/internal-ai.ts`) — sketch in [§Discovery → Proposed shape](#proposed-shape-of-the-internal-wrapper). Exports:

- `summarizeWithInternalAi({ harness, systemPrompt, userPrompt }) → Promise<string>` — generic completion call.
- A higher-level `summarizeSessionViaInternalAi({ harness, transcript, retrievals?, taskContext? }) → Promise<SummaryWithRatings | null>` that wraps the prompt construction (using the existing `buildSummaryWithRatingsPrompt` from `llm.ts:179`) and parses the response through `SummaryWithRatingsSchema`. Returns `null` when no API key resolves (graceful no-op like claude's hook).

Internally it dispatches on the harness to pick a default model (Gemini 3 Flash via OpenRouter for most; codex possibly via OpenAI Codex API), resolves auth via `getEnvApiKey` / `getOAuthApiKey` / harness-specific auth files, and calls `complete()` from pi-ai.

Verification: unit tests with a mocked `complete()` covering each harness's auth-resolution path + an integration test against OpenRouter (gated on `OPENROUTER_API_KEY`).

### Phase 1: Pi — replace the `claude -p` shellout with the wrapper

Inside `src/providers/pi-mono-extension.ts:280-376`, replace lines 326-351 (tmpfile write → `Bun.spawn` → JSON parse) with a single call to `summarizeSessionViaInternalAi({ harness: "pi", transcript, retrievals, taskContext })`. Steps:

1. Top-of-function gate stays similar but checks "any usable auth resolves for pi" rather than hardcoded `OPENROUTER_API_KEY`. The wrapper's `null` return covers the no-auth case.
2. Optionally call `fetchRetrievalsForTask` first (mirrors `hook.ts:1126`) so the wrapper can build the augmented prompt.
3. Keep the existing `summary.length > 20 && !includes("no significant learnings")` gate (lines 353-357) and the `/api/memory/index` POST (lines 358-371).
4. Add `postRatings(...)` call mirroring `hook.ts:1203-1214` so per-memory ratings flow too.
5. Delete the inline `summarizePrompt` literal at lines 307-324 — the wrapper builds the prompt internally via `buildSummaryWithRatingsPrompt`.
6. **Add a single `console.error` log line in the outer catch at line 373-375** so silent failures stop being silent. (Or better, `POST /api/agents/<id>/activity` with an error payload.)

### Phase 2: Opencode — source a transcript, then call the wrapper

The opencode plugin's dead code at `plugin/opencode-plugins/agent-swarm.ts:236-332` is irrelevant — even fixing the shellout wouldn't help because `sessionFile` is `undefined`. The real blocker is **how to obtain a transcript**. Two options visible in the code:

- **(a) Use opencode's session-message API**: opencode SDK exposes session messages programmatically. The plugin already imports from `@opencode-ai/plugin` and could call into opencode's session storage at `session.idle` time to read the transcript. (Out-of-scope for this audit to verify which exact API; the plugin author would need to consult the opencode plugin docs.)
- **(b) Accumulate via existing event hooks**: `tool.execute.before` (line 381), `tool.execute.after` (line 408), `experimental.chat.system.transform` (line 418) already get fired during the session. The plugin could buffer these into a transcript-like string and pass that to `summarizeSession` at `session.idle`.

Either way: once a transcript string is in hand, replace the function body to call `summarizeSessionViaInternalAi({ harness: "opencode", ... })` instead of the `claude -p` shellout. The credential surface for opencode (review comment 2: "creds are similar to pi") is handled inside the wrapper.

### Phase 3: Codex — build the missing path adapter-side

Codex has no harness-side hook surface (review comment 4 — "we should add it"), so summarization has to happen *adapter-side* — inside `src/providers/codex-adapter.ts`, near the `runSession` finally-block at lines 829-838 or right before the `result` event is fired (lines 803-808). Steps:

1. **Source the transcript**: during `runSession`, accumulate `tool_start` / `tool_end` / `item.started` / `turn.completed` payloads into a transcript buffer (around lines 577-705 where these events are produced). Truncate to last 20 KB, matching claude's pattern (`hook.ts:1098-1100`).
2. **Wire the summarize step**: in the finally-block at line 829 (or just before `progressCompletion` at `swarm-events-shared.ts:253`), check `!SKIP_SESSION_SUMMARY`, call `summarizeSessionViaInternalAi({ harness: "codex", transcript, ... })`, POST to `/api/memory/index` with `source: "session_summary"` on success.
3. **Identity** is already plumbed for codex (cancellation polling has `agentId` and `taskId`), so no extra wiring needed.
4. **Test**: add a unit test parallel to existing codex tests that asserts the memory POST happens at session end given a resolvable codex auth.

### Phase 4 (cleanup): delete dead `LlmRater` / `ClaudeCliLlmRaterClient` machinery

Once the wrapper is the single LLM-call path for workers:

- Delete `src/be/memory/raters/llm-client.ts` entirely (`ClaudeCliLlmRaterClient`, `getDefaultLlmRaterClient`, `MEMORY_LLM_RATER_PROVIDER` env handling).
- Delete the `LlmRater` class (`llm.ts:70`) and remove it from `registry.ts:32`. Keep the helpers (`buildSummaryWithRatingsPrompt`, `buildRatingsFromLlm`, `SummaryWithRatingsSchema`, `fetchRetrievalsForTask`, `postRatings`) — those are still live.
- Update or delete `src/tests/memory-rater-llm.test.ts` accordingly.
- Update `MEMORY_RATERS` documentation to no longer mention `llm` as a rater value.

### Minimal-change alternative (skip the wrapper)

If we don't want to introduce a new module, the smaller fix is:

- **Pi/opencode**: replace the `Bun.spawn → claude -p` shellout with `runMemoryRater({ prompt, apiKey: process.env.OPENROUTER_API_KEY })`. Hardcoded to OpenRouter, gated on `OPENROUTER_API_KEY`, no per-provider auth dispatch. Works for any deployment that has OpenRouter configured (which is most of `cloud.agent-swarm.dev`).
- **Codex**: same `runMemoryRater` call from inside the adapter `runSession` finally-block.
- **Drawback**: pi sessions configured with only `ANTHROPIC_API_KEY` or pi `auth.json` (and no OpenRouter) still get no summary. The wrapper-based approach handles those.

Roughly 50 LOC for the minimal-change path, vs ~300 LOC for the wrapper + tests. Recommendation: do the wrapper if codex needs to support OAuth-only deployments; do the minimal path if every production deployment is guaranteed to have `OPENROUTER_API_KEY`.

### Cross-cutting observations

- **The shared worker image bundles `claude` for all providers** (Dockerfile.worker:82-86), which masks the "binary not on PATH" failure mode. The real failure is **auth** — `claude -p` needs ANTHROPIC creds that pi/opencode runtimes typically don't provide. Removing the shellout entirely sidesteps both issues.
- **Silent error swallowing is the second-order bug**: `pi-mono-extension.ts:373` and `agent-swarm.ts:329-331` both have `try { … } catch { /* non-blocking */ }` with no log line. Even after fixing the LLM call, leaving these silent will make future regressions undetectable. A one-line `console.error("session_summary failed:", err)` (or, better, a `POST /api/agents/<id>/activity` with an error payload) in each catch would have surfaced the current bug months ago.
- **Three independent copies of the same shellout**: `pi-mono-extension.ts:332`, `agent-swarm.ts:288`, and `llm-client.ts:128` all encode the `claude -p --model haiku --output-format json` pattern. Whichever fix is chosen, replacing all three with the wrapper avoids future divergence.
- **Migration history (CHANGELOG #450)**: the same `claude -p` shellout pattern was the cause of the documented "0 LLM rater rows ever, 417 garbage session-summary rows over 2 days" incident after the 2026-05-05 `CLAUDE_CODE_VERSION` bump (2.1.112 → 2.1.126) stopped propagating `CLAUDE_CODE_OAUTH_TOKEN` to hook subprocesses. The fix migrated **claude's Stop hook only** to OpenRouter via `runMemoryRater`. The pi/opencode/codex broken-or-missing paths are leftovers from the same family of bugs.

## Appendix

**Architecture notes**:
- Workers MUST NOT touch `bun:sqlite` (CLAUDE.md "Architecture invariants"); enforced by `scripts/check-db-boundary.sh`. This rules out any worker-side fix that imports from `src/be/db.ts`. Both `runMemoryRater` and the proposed pi-ai wrapper satisfy this — pi-ai itself has no `bun:sqlite` coupling, and the wrapper would only do `fetch` to provider APIs + POST to `/api/memory/index`.
- The shared worker Docker image installs every harness CLI (`claude`, `codex`, `pi`, `opencode`) regardless of `HARNESS_PROVIDER`; the entrypoint only verifies the active one. This is why "claude is not in the pi container" is technically incorrect today — but the failure mode (silent auth fail) still produces the same user-visible result (no summary indexed).
- Memory rater LLM is `google/gemini-3-flash-preview` via OpenRouter by default (`llm-summarizer.ts:21`, `:53-57`). This matches the project-default Gemini model documented in `CLAUDE.md`. CHANGELOG #450 cites cost: $0.5/M input + $3/M completion vs Haiku 4.5's $1/M + $5/M.
- The `LlmRater` class hierarchy in `src/be/memory/raters/` reflects an earlier design intent (worker-callable rater interface) that was abandoned in favor of `runMemoryRater` (#450). The interface remains for tests but is unused in production. Phase 4 of the proposed solution removes it.

**Historical context (from thoughts/)**:
- `thoughts/taras/research/2026-05-04-bayesian-learning-memory.md` — relevant prior research on the memory-rating system that consumes session_summary rows.

**Related research**:
- (none discovered for this specific topic)
