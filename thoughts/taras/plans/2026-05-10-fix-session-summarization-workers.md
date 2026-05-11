---
date: 2026-05-10T00:00:00Z
planner: Claude
git_commit: 9a76c96f9b859fdd853c45fa4af1b0b9fef3e77f
branch: main
repository: agent-swarm
topic: "Fix session summarization across worker harness providers (pi, opencode, codex, claude) + reusable structured-output abstraction"
tags: [plan, memory, session-summary, harness-providers, pi, opencode, codex, claude, pi-ai, structured-output]
status: completed
autonomy: critical
last_updated: 2026-05-11
last_updated_by: Claude (orchestrator)
revisions:
  - "v1 (2026-05-10): scaffold"
  - "v2 (2026-05-10): full draft after research + critical questions; reframed around reusable structured-output abstraction; added Phase 4 (claude migration with CLAUDE_CODE_OAUTH_TOKEN fallback)"
  - "v3 (2026-05-10): review pass — applied Important + Minor fixes (typebox derail note, plugin import path gate, kind=<provider> log spec, fetchTaskDetails citations, status → draft, Phase 0 commit scope) + Critical fixes (harness/callerTag, opencode auth split, newCredentials persistence, pi-ai discriminator locked to type:'toolCall'/arguments)"
  - "v4 (2026-05-10): file-review pass — corrected LlmRater 'dead code' mis-read (alive worker-side, 461 events/24h in prod); narrowed Phase 5 to only delete ClaudeCliLlmRaterClient + runMemoryRater; LlmRater migration spun out as a separate Linear issue; renamed default openai/openai-codex models to gpt-5.4-mini"
  - "v5 (2026-05-11): Phases 0–4 implemented and committed on branch fix-session-summarization-workers (commits 49e44ffb, e9cfb966, ab6984db, 5f8a144d, dc21da86, 633de31a). **Phase 5 cancelled** per Taras after the documented blocker hit during execution: deleting llm-client.ts is intrinsically coupled to migrating LlmRater (which uses ClaudeCliLlmRaterClient as its default client). All Phase 5 cleanup (llm-client.ts/llm-summarizer.ts removal, MEMORY_LLM_RATER_PROVIDER sweep, runbook updates, soft-deprecation warning) is folded into DES-363."
---

# Fix Session Summarization Across Worker Harness Providers — Implementation Plan

## Overview

Build a reusable **structured-output LLM abstraction** at `src/utils/internal-ai/` around `@mariozechner/pi-ai` (already a dep at `package.json:108`), then migrate every worker harness (pi, opencode, codex, claude) to use it for end-of-session summarization. The abstraction is **callable from both worker subprocesses and the API server** — it just attempts a structured completion using whatever env vars and (optional) HTTP API access it has in the current context. Today only claude works (post-#450); pi silently fails on auth, opencode is dead code (`sessionFile=undefined`), codex has no SessionEnd path at all. The abstraction is the durable artifact — session summary + per-memory ratings are its first consumers; future raters / workflow LLM steps / skill resolution / plan validation can reuse it without reinventing credential resolution, model selection, retries, or schema validation.

- **Motivation**: Three of four worker harnesses produce zero `session_summary` rows in production. Worse, three independent copies of `Bun.spawn → claude -p` exist (`pi-mono-extension.ts:332`, `agent-swarm.ts:288`, `llm-client.ts:128`) — proof that "one-off LLM helper" is the wrong shape. A general structured-output abstraction prevents the pattern from recurring.
- **Related**:
  - Research: `thoughts/taras/research/2026-05-10-summarize-session-provider-gaps.md`
  - Working baseline: `src/hooks/hook.ts:1043` (claude Stop handler) + `src/be/memory/raters/llm-summarizer.ts:134` (`runMemoryRater`)
  - Broken: `src/providers/pi-mono-extension.ts:280-376`, `plugin/opencode-plugins/agent-swarm.ts:236-332`, `src/providers/codex-adapter.ts:577-838`
  - Dead code to retire: `src/be/memory/raters/llm-client.ts`, `LlmRater` in `llm.ts:70`
  - CHANGELOG #450 — prior migration of claude hook from `claude -p` to OpenRouter
  - Feedback memory: `feedback_internal_ai_abstraction.md` — design principle this plan implements

## Current State Analysis

**Session-summary state per harness** (sourced verbatim from research doc):

| Harness | Hook surface | LLM call | Today's outcome |
|---|---|---|---|
| `claude` (OAuth) | Claude Code `Stop` hook → `bunx @desplega.ai/agent-swarm hook` (`plugin/hooks/hooks.json:59-69`) → `src/hooks/hook.ts:1043` | `runMemoryRater()` (`src/be/memory/raters/llm-summarizer.ts:134`) direct `fetch` to OpenRouter. Gated on `OPENROUTER_API_KEY`. | ✅ **Works** when `OPENROUTER_API_KEY` set. |
| `pi` | pi-mono native `session_shutdown` hook (`src/providers/pi-mono-extension.ts:640`) | `Bun.spawn(["bash","-c", "cat $tmpFile \| ${CLAUDE_BINARY:-claude} -p --model haiku --output-format json"])` at `pi-mono-extension.ts:332`. Errors swallowed at `:373`. | ❌ **Fails silently**: `claude -p` needs Anthropic auth that pi sessions typically don't have. |
| `opencode` | `session.idle` event handler (`plugin/opencode-plugins/agent-swarm.ts:362-377`) | Calls `summarizeSession(config, undefined)`; function body returns at line 240 because `sessionFile` is undefined. | ❌ **Dead code**: opencode SDK doesn't pass a transcript path. The `claude -p` shellout at line 288 never executes. |
| `codex` | None | None. `runSession` finally-block (`src/providers/codex-adapter.ts:829-838`) only flushes log writer + cleans up AGENTS.md. | ❌ **Missing entirely**. |

**Reusable building blocks already in the codebase** (these stay live):
- `buildSummaryWithRatingsPrompt(basePrompt, retrievals)` — `src/be/memory/raters/llm.ts:179`
- `buildRatingsFromLlm(...)` — `src/be/memory/raters/llm.ts:135`
- `SummaryWithRatingsSchema` (zod) — `src/be/memory/raters/llm.ts:52`
- `fetchRetrievalsForTask(...)` / `postRatings(...)` — `src/be/memory/raters/llm.ts:300, :335`

**Dead code blocking cleanup** (Phase 5 target — **revised after review**):
- ~~`LlmRater` class~~ — **KEEP**: prior research mis-read `SERVER_RATERS = Set(["implicit-citation"])` (`registry.ts:43`) as "filtered out". The comment at `registry.ts:36-41` explicitly says: *"Worker-driven raters (e.g. step-4's `LlmRater`, step-5's `ExplicitSelfRater`) emit events from outside this set and POST them to `/api/memory/rate`."* `LlmRater` IS alive — it's instantiated worker-side. Prod digest (2026-05-10): 461 events / 132 memories rated by `llm` in 24h. Migration of `LlmRater` to the new `completeStructured` abstraction (and breaking its hardcoded OpenRouter dependency) is a **separate Linear issue** — see Appendix > Follow-up plans.
- `ClaudeCliLlmRaterClient` — `src/be/memory/raters/llm-client.ts:111` (zero production importers — still deletable)
- `getDefaultLlmRaterClient()` + `MEMORY_LLM_RATER_PROVIDER` env handling — `llm-client.ts:164` (still deletable IF `LlmRater` doesn't transitively use it — verify in Phase 5 pre-check)
- `runMemoryRater()` — `src/be/memory/raters/llm-summarizer.ts:134` (becomes redundant once Phase 4 lands — claude hook is its only consumer)

**Spike findings** (`scripts/spike-internal-ai.ts`, run 2026-05-10 against real `.env` creds):

| Provider | Model | `stopReason` | Tool-call shape | zod validation |
|---|---|---|---|---|
| `openrouter` | `google/gemini-3-flash-preview` | `toolUse` | `content: [{ type: "toolCall", name, arguments: {...} }]` | ✅ pass |
| `openai` | `gpt-5.4-mini` | `toolUse` | same shape | ✅ pass |
| `anthropic` | `claude-haiku-4-5` | `toolUse` | same shape | ✅ pass |

Empirically confirms the v3 patches: discriminator IS `"toolCall"` (camelCase), payload IS `arguments`. typebox `Type.Object` works directly as `parameters` on the Tool — no conversion layer needed. `stopReason: "toolUse"` is an additional early-exit signal that `completeStructured` can use to short-circuit instead of always scanning `content[]`.

**pi-ai surface available** (`node_modules/@mariozechner/pi-ai@0.73.0`):
- `complete(model, context, options?) → Promise<AssistantMessage>` from `dist/stream.d.ts:5`. `options.apiKey?: string` optional; falls back to env. `AssistantMessage.content` is `(TextContent|ThinkingContent|ToolCall)[]` — array, not string. Extract text: `msg.content.find(c => c.type === "text")?.text ?? ""`.
- `getModel(provider, modelId)` from `dist/models.d.ts:6` — two-arg form. Existing usage in `src/providers/pi-mono-adapter.ts:153-175` parses `"provider/model-id"` strings (splits on first `/`).
- `getEnvApiKey(provider) → string | undefined` from `dist/env-api-keys.d.ts:16`. Does not throw.
- `getOAuthApiKey(providerId, credentials) → Promise<{newCredentials, apiKey} | null>` from `dist/utils/oauth/index.d.ts:53`. `credentials` is a **map** keyed by provider id. Handles refresh internally.
- `Tool<TSchema>` uses **typebox** schemas (`types.d.ts:168`). No `tool_choice: required` flag; relies on prompting + the tool being the only option.
- OpenRouter routing confirmed (`baseUrl: "https://openrouter.ai/api/v1"` in `models.generated.js`).

**Codex transcript sources** (`src/providers/codex-adapter.ts`):
- Assistant text: `item.completed` event with `item.type === "agent_message"` → `msg.text` (`L621-627`).
- Tool calls: `item.started` with `tool_start` event carries `toolName` + `args` (`L578-585`).
- Tool results: `item.completed` for tool items carries `result: item` (full SDK item — command output, file changes) (`L611-619`).
- User prompt: `this.config.prompt` (raw) → `resolvedPrompt` (after slash-command resolution) at `L767`.
- Identity at finally: `this.config.{agentId, taskId, apiUrl, apiKey}` already in scope.

**Opencode transcript source** (`node_modules/@opencode-ai/`):
- `client.session.messages({ path: { id: sessionID } })` from `sdk.gen.d.ts:170` returns `Array<{ info: Message; parts: Part[] }>`.
- Plugin already receives `_input.client` at `agent-swarm.ts:334` (currently discarded).
- `TextPart = { type:"text", text: string }` (`types.gen.d.ts:142-157`); `ToolPart = { type:"tool", callID, tool, state, metadata? }` (`types.gen.d.ts:263-274`).

**Codex OAuth retrieval** (worker-safe):
- `getValidCodexOAuth(apiUrl, apiKey)` from `src/providers/codex-oauth/storage.ts:88` — loads from `/api/config/resolved?key=codex_oauth&includeSecrets=true`, checks expiry, calls `refreshAccessToken` if needed, re-stores, returns `{ access, refresh, expires, accountId }`. This is the canonical worker-side path; no direct `~/.codex/auth.json` read needed.

## Desired End State

After all phases land:

1. `src/utils/internal-ai/` is the single source of truth for any LLM call requiring structured output anywhere in the codebase (worker subprocesses AND the API server). Exports `completeStructured<TZod>({...})` (context-agnostic lower layer; works with whatever env vars / optional HTTP API access the caller has) and `summarizeSession({...})` (worker-side domain helper for session-end hooks).

2. All four harnesses (claude, pi, opencode, codex) call `summarizeSession` at session end. Each produces a `source: "session_summary"` memory in `agent_memory` and per-memory rating events when retrievals exist and `MEMORY_RATERS` includes `llm`.

3. Credential resolution inside the wrapper is precedence-ordered: `OPENROUTER_API_KEY → ANTHROPIC_API_KEY → OPENAI_API_KEY → codex OAuth (codex harness only) → CLAUDE_CODE_OAUTH_TOKEN fallback to claude -p`. Each credential maps to a default model (per-credential, not per-harness):
   - `openrouter` → `openrouter/google/gemini-3-flash-preview`
   - `anthropic` → `anthropic/claude-haiku-4-5`
   - `openai` → `openai/gpt-5-mini`
   - `openai-codex` (OAuth, codex harness only) → `openai-codex/gpt-5-mini`
   - `CLAUDE_CODE_OAUTH_TOKEN` → `Bun.spawn(claude -p --model haiku --output-format json)` (last-resort path; only when no other auth resolves; preserves CHANGELOG #450 working path for Pro/Max OAuth users)

4. Silent failures end: every catch in the new paths logs (`console.error("session_summary failed (<harness>):", err)`) before swallowing.

5. Dead code (`LlmRater`, `ClaudeCliLlmRaterClient`, `getDefaultLlmRaterClient`, `MEMORY_LLM_RATER_PROVIDER`, `runMemoryRater`) is removed.

6. Verification: `bun test src/tests/internal-ai/` covers credential resolution, retry logic, summary serialization. Each harness has at least one integration-style test that mocks `complete()` and asserts the `/api/memory/index` POST body.

## What We're NOT Doing

- **Devin / claude-managed**: different flow, intentionally unsupported in this plan.
- **Workflow-side LLM clients** (`src/workflows/executors/raw-llm.ts`, `validate.ts`): API-server-side via `@ai-sdk/openai`. The new `completeStructured` is callable from the API server so a follow-up plan can converge these onto it, but THIS plan does not migrate them (keeps blast radius scoped).
- **Migrating `src/commands/claude-managed-setup.ts:483`** (one-off Anthropic SDK call for managed-agent setup) — orthogonal.
- **Adding new memory sources** (e.g. per-tool-call structured memories) — out of scope.
- **Prompt iteration**: the prompt copy from `hook.ts:1132-1149` (claude's `baseSummarizePrompt`) is reused verbatim by the new helper. Prompt quality work is a separate concern.

## Implementation Approach

- **Phase 0 is the foundation**: build the reusable `completeStructured<T>` first, then layer `summarizeSession` on top. Lower layer has independent unit tests; upper layer reuses them.
- **Sequenced by risk**: Phase 1 (pi) and Phase 3 (codex) are pure additions or silent-fail replacements — low blast radius. Phase 2 (opencode) requires plugging the SDK client through. Phase 4 (claude migration) touches the working path last, gated on phases 0–3 passing.
- **Tests are mock-driven**: each harness phase mocks `complete()` (or `summarizeSession` itself) and asserts the `/api/memory/index` POST body shape — same pattern as the existing `src/tests/codex-adapter.test.ts:34-52` `makeFakeThread` helper.
- **Retries inside the wrapper, not the consumer**: `completeStructured` retries on parse/schema-validation failure up to 3 times before returning `null`. Consumers always see "got a valid structured object" or "didn't" — they don't reimplement retry logic.
- **`CLAUDE_CODE_OAUTH_TOKEN` fallback is opt-out, not opt-in**: when no other credential resolves and `CLAUDE_CODE_OAUTH_TOKEN` is in env (typical for Pro/Max OAuth users), shell out to `claude -p`. This preserves CHANGELOG #450's working path for that user segment without forcing them to obtain an OpenRouter key.

## Quick Verification Reference

- `bun test src/tests/internal-ai/` — Phase 0 unit tests
- `bun test src/tests/pi-mono-extension.test.ts` — Phase 1
- `bun test src/tests/opencode-plugin.test.ts` — Phase 2
- `bun test src/tests/codex-adapter.test.ts` — Phase 3 (extend existing)
- `bun test src/tests/claude-stop-hook.test.ts` — Phase 4
- `bun run tsc:check`
- `bun run lint`
- `bash scripts/check-db-boundary.sh` — workers MUST NOT touch `bun:sqlite`
- `bun run docker:build:worker` — confirm Docker still builds when plugin file changes

---

## Phase 0: Reusable structured-output abstraction + session-summary helper

### Overview

Ship `src/utils/internal-ai/` — a directory module exporting `completeStructured<TZod>({...})` (general-purpose LLM-with-structured-output wrapper) and `summarizeSession({...})` (thin domain helper that composes the lower layer with `buildSummaryWithRatingsPrompt` + `SummaryWithRatingsSchema`). No consumer migrations in this phase — just the abstraction + unit tests.

### Changes Required:

#### 1. New module layout

**Files** (all new):

- `src/utils/internal-ai/index.ts` — barrel: re-exports `completeStructured`, `summarizeSession`, and the public types.

- `src/utils/internal-ai/models.ts` — per-credential default model registry:
  ```ts
  export type CredentialKind = "openrouter" | "anthropic" | "openai" | "openai-codex" | "claude-cli";

  export const DEFAULT_MODEL: Record<CredentialKind, string> = {
    "openrouter":   "openrouter/google/gemini-3-flash-preview",
    "anthropic":    "anthropic/claude-haiku-4-5",
    "openai":       "openai/gpt-5.4-mini",
    "openai-codex": "openai-codex/gpt-5.4-mini",
    "claude-cli":   "haiku", // shorthand consumed by `claude -p --model haiku`
  };

  // Overridable via MEMORY_RATER_MODEL env (keeps backwards compat with claude hook).
  export function resolveModelString(kind: CredentialKind): string {
    return process.env.MEMORY_RATER_MODEL ?? DEFAULT_MODEL[kind];
  }

  // Mirrors pi-mono-adapter.ts:161-170 — split on FIRST "/" so openrouter IDs like
  // "openrouter/google/gemini-3-flash-preview" work.
  export function parseModelStr(modelStr: string): [provider: string, modelId: string] {
    const idx = modelStr.indexOf("/");
    if (idx < 0) throw new Error(`invalid model string (no '/'): ${modelStr}`);
    return [modelStr.slice(0, idx), modelStr.slice(idx + 1)];
  }
  ```

- `src/utils/internal-ai/credentials.ts` — credential resolver. Context-agnostic: tries env vars first, then optionally probes codex OAuth via HTTP if `apiUrl + apiKey` are provided. Exports:
  ```ts
  export type ResolvedCredential =
    | { kind: "openrouter" | "anthropic" | "openai" | "openai-codex"; apiKey: string; modelDefault: string }
    | { kind: "claude-cli"; modelDefault: string }; // no apiKey — uses claude CLI auth

  export async function resolveCredential(opts: {
    env?: NodeJS.ProcessEnv;       // defaulted to process.env; injectable for tests
    apiUrl?: string;               // optional: enables codex-OAuth lookup over HTTP
    apiKey?: string;               // optional: paired with apiUrl
    // Optional log tag — purely for diagnostics, not load-bearing:
    callerTag?: string;
  }): Promise<ResolvedCredential | null>;
  ```
  Precedence (top wins):
  1. `env.OPENROUTER_API_KEY` (or pi-ai's `getEnvApiKey("openrouter")`) → `{ kind: "openrouter", apiKey, modelDefault: resolveModelString("openrouter") }`
  2. `env.ANTHROPIC_API_KEY` (or `getEnvApiKey("anthropic")`) → `{ kind: "anthropic", apiKey, modelDefault: resolveModelString("anthropic") }`
  3. `env.OPENAI_API_KEY` (or `getEnvApiKey("openai")`) → `{ kind: "openai", apiKey, modelDefault: resolveModelString("openai") }`
  4. **If `apiUrl && apiKey` provided**: try `getValidCodexOAuth(apiUrl, apiKey)` from `src/providers/codex-oauth/storage.ts`. If returns non-null `{access, refresh, expires}`, reshape to pi-ai's `{ "openai-codex": { access, refresh, expires } }` map and call `getOAuthApiKey("openai-codex", map)`. pi-ai returns `{newCredentials, apiKey} | null` per `node_modules/@mariozechner/pi-ai/dist/utils/oauth/index.d.ts:53`. **Persist `newCredentials`** by writing it back via `/api/config?key=codex_oauth` (same path `getValidCodexOAuth` used to load) — if you skip this, the refresh-token rotation is lost and the next session attempts the old expired access token. Then return `{ kind: "openai-codex", apiKey, modelDefault: resolveModelString("openai-codex") }`. **No `harness` check** — the only cost of attempting is one localhost HTTP call.

     Add a helper `persistCodexOAuth(apiUrl, apiKey, newCredentials)` next to `getValidCodexOAuth` in `src/providers/codex-oauth/storage.ts` (or co-locate in `src/utils/internal-ai/credentials.ts` if `storage.ts` is API-side only — verify during impl). Wrap the write in try/catch + `console.error` — persistence failure should NOT block the current call's `apiKey` from being used.
  5. `env.CLAUDE_CODE_OAUTH_TOKEN` → `{ kind: "claude-cli", modelDefault: resolveModelString("claude-cli") }`. **No apiKey** — the `claude` CLI uses the env var directly. (Applies in any context — worker or API server — though API-server callers will rarely have this token set.)
  6. None of the above → `return null` (caller does graceful no-op).

  Implementation note: for `openrouter`/`anthropic`/`openai`, prefer pi-ai's `getEnvApiKey(provider)` from `dist/env-api-keys.d.ts:16` over reading `env.XYZ` directly — it knows about provider-specific env var name variations.

  **Dual-use note**: when called from the API server, `apiUrl` should be the loopback URL of the API server itself (e.g. `MCP_BASE_URL`); `apiKey` is the same `API_KEY` env. The codex-OAuth probe just calls back into `/api/config/resolved` over localhost — no special-casing needed. Workers pass through their existing `config.apiUrl` / `config.apiKey`.

- `src/utils/internal-ai/complete-structured.ts` — main entry. Context-agnostic: callable from both worker subprocesses and the API server. Exports:
  ```ts
  import type { z } from "zod";
  import type { TSchema } from "typebox";

  export interface CompleteStructuredOptions<TZod extends z.ZodTypeAny> {
    zodSchema: TZod;                    // for output validation
    toolSchema: TSchema;                // for pi-ai Tool<TSchema> def
    toolName: string;
    toolDescription: string;
    systemPrompt: string;
    userPrompt: string;
    // Optional context for codex-OAuth lookup. When omitted, only env vars are tried.
    // - Workers: pass config.apiUrl / config.apiKey.
    // - API server: pass MCP_BASE_URL / API_KEY (loopback).
    // - Skip entirely if you don't want codex OAuth probing.
    apiUrl?: string;
    apiKey?: string;
    retries?: number;                   // default 3
    signal?: AbortSignal;
    callerTag?: string;                 // optional diagnostic tag (e.g. "session-summary:pi")
    // Injection points for tests:
    _resolveCredential?: typeof resolveCredential;
    _complete?: typeof import("@mariozechner/pi-ai").complete;
    _spawnClaudeCli?: (prompt: string) => Promise<string>;  // for claude-cli kind
  }

  export async function completeStructured<TZod extends z.ZodTypeAny>(
    opts: CompleteStructuredOptions<TZod>,
  ): Promise<z.infer<TZod> | null>;
  ```
  Behavior:
  1. `const cred = await (opts._resolveCredential ?? resolveCredential)({ env: process.env, apiUrl: opts.apiUrl, apiKey: opts.apiKey, callerTag: opts.callerTag })`.
  2. If `cred === null`, return `null` (no auth — graceful no-op).
  3. If `cred.kind === "claude-cli"`:
     - Invoke `claude -p --model ${cred.modelDefault} --output-format json` with `${systemPrompt}\n\n${userPrompt}` on stdin (reuse the existing shellout pattern from `pi-mono-extension.ts:328-351`, but inside this helper — single copy).
     - Parse JSON envelope: `JSON.parse(stdout).result`.
     - Try `zodSchema.safeParse(JSON.parse(result))`. If success → return `data`. If failure → retry up to `retries` (rebuild stdin unchanged; CLI may be flaky).
     - Wrap in 30s `setTimeout → proc.kill()`. Cleanup: ensure stderr is read and surfaced into `console.error` on non-zero exit.
  4. Otherwise (pi-ai path):
     - `const [provider, modelId] = parseModelStr(cred.modelDefault)`.
     - `const model = getModel(provider as any, modelId as any)`.
     - Build pi-ai `Tool<typebox>`: `{ name: toolName, description: toolDescription, parameters: toolSchema }`.
     - Loop up to `retries`:
       - `const msg = await (opts._complete ?? complete)(model, { systemPrompt, messages: [{role:"user", content: userPrompt}], tools: [tool] }, { apiKey: cred.apiKey, signal })`.
       - Find `ToolCall` block: `msg.content.find(c => c.type === "toolCall")`. **Verified against `node_modules/@mariozechner/pi-ai/dist/types.d.ts:117-123` during planning** — the discriminator is the camelCase literal `"toolCall"` (not `"tool_call"` or `"tool_use"`).
       - If no tool call → mutate `userPrompt += "\n\nYou did not call the ${toolName} tool. You MUST call it with the requested arguments."` and continue loop.
       - `const parsed = zodSchema.safeParse(toolCall.arguments)` — the payload field is `arguments: Record<string, any>` per the same `ToolCall` interface.
       - If `parsed.success` → return `parsed.data`.
       - If `!parsed.success` → mutate `userPrompt += "\n\nThe ${toolName} arguments did not validate: ${parsed.error.message}. Please retry with correct arguments."` and continue loop.
  5. Exhausted retries → `console.error("internal-ai: structured output failed after", retries, "retries (callerTag=", opts.callerTag ?? "<unset>", "kind=", cred.kind, ")", lastErr)` and return `null`.

  **Always-on debug log (required by Manual E2E + Phase 4 QA)**: at the start of each successful credential resolution, emit one line: `console.log("internal-ai: kind=" + cred.kind + " callerTag=" + (opts.callerTag ?? "<unset>"))`. This is what `grep -E "internal-ai: kind=..."` in Manual E2E Scenario 5 and Phase 4 QA depends on — do NOT make it conditional on a verbose flag.

- `src/utils/internal-ai/summarize-session.ts` — worker-side domain helper for session-end hooks. Composes `completeStructured` with `SummaryWithRatingsSchema`. Exports:
  ```ts
  import { Type } from "typebox";
  import { SummaryWithRatingsSchema } from "../../be/memory/raters/llm";  // existing zod
  import { buildSummaryWithRatingsPrompt } from "../../be/memory/raters/llm";

  export interface SummarizeSessionOptions {
    harness: "claude" | "pi" | "opencode" | "codex"; // log/diagnostic tag only
    transcript: string;            // pre-truncated by caller
    retrievals: RetrievalRow[];    // [] when not fetching ratings
    taskContext: { sourceTaskId: string; agentId: string; prompt?: string };
    apiUrl: string;                // passed through to completeStructured for codex OAuth
    apiKey: string;
    signal?: AbortSignal;
    _completeStructured?: typeof completeStructured; // test injection
  }

  export async function summarizeSession(
    opts: SummarizeSessionOptions,
  ): Promise<z.infer<typeof SummaryWithRatingsSchema> | null>;
  ```
  Note: this helper is worker-side because it consumes a session transcript. API-server callers who want structured AI completion call `completeStructured` directly with their own schemas.
  Behavior:
  1. If `opts.transcript.length <= 100`, return `null` (degenerate).
  2. Build `baseSummarizePrompt` — extract the literal from `hook.ts:1132-1149` into an **exported constant** `BASE_SUMMARIZE_PROMPT` in `src/be/memory/raters/llm.ts` so both claude's hook (until Phase 4) and this helper share one source of truth. Add an optional `Task: ${opts.taskContext.prompt}` line + `Transcript:\n${opts.transcript}` blob.
  3. `const userPrompt = buildSummaryWithRatingsPrompt(baseSummarizePrompt, opts.retrievals)` from `llm.ts:179`.
  4. Build typebox tool schema mirroring `SummaryWithRatingsSchema`:
     ```ts
     const summaryToolSchema = Type.Object({
       summary: Type.String(),
       ratings: Type.Array(Type.Object({
         memoryId: Type.String(),
         rating: Type.Number(),
         reason: Type.String(),
       })),
     });
     ```
     Add a parity test that confirms typebox schema accepts exactly what zod schema accepts (using `Value.Check` + `safeParse` on a small fixture set).
  5. `return await (opts._completeStructured ?? completeStructured)({ zodSchema: SummaryWithRatingsSchema, toolSchema: summaryToolSchema, toolName: "record_session_summary", toolDescription: "Record the high-value learnings extracted from this session, plus per-memory ratings of any retrievals.", systemPrompt: "You are an expert at extracting durable, generalizable learnings from agent sessions.", userPrompt, callerTag: \`session-summary:${opts.harness}\`, apiUrl: opts.apiUrl, apiKey: opts.apiKey, signal: opts.signal, retries: 3 });`

  **Note on `harness` propagation**: `summarizeSession` accepts `harness` as a tag in its own options for diagnostics, but it does NOT pass `harness` directly to `completeStructured` — instead it derives `callerTag` (e.g. `"session-summary:pi"`). `completeStructured`'s interface and behavior are deliberately harness-agnostic.`

#### 2. Extract `BASE_SUMMARIZE_PROMPT` constant

**File**: `src/be/memory/raters/llm.ts`
**Changes**: Add at top:
```ts
export const BASE_SUMMARIZE_PROMPT = `<paste literal from hook.ts:1132-1149 verbatim>`;
```
This is a no-op refactor for now (claude's hook still inlines its own copy until Phase 4); the new helper imports it.

#### 3. Verify `fetchRetrievalsForTask` and `postRatings` are worker-safe

**File**: `src/be/memory/raters/llm.ts`
**Changes**: Add a comment at the top of each function: `// Worker-safe: uses fetch() only, no bun:sqlite import.` Run `grep -n "bun:sqlite" src/be/memory/raters/llm.ts` to confirm zero matches. If `llm.ts` transitively imports `bun:sqlite` via something we missed, **lift the HTTP-only helpers into `src/be/memory/raters/http-helpers.ts` and re-export from `llm.ts`** before proceeding. Phase 0 cannot ship if workers can't safely import these.

#### 4. Test suite

**New file**: `src/tests/internal-ai/credentials.test.ts`:
- Each precedence case (OPENROUTER, ANTHROPIC, OPENAI, codex OAuth, CLAUDE_CODE_OAUTH_TOKEN-fallback) — mock env + `getValidCodexOAuth`, assert returned `{kind, modelDefault}`.
- "No creds at all" → returns `null`.
- "Multiple creds" → highest precedence wins (OPENROUTER beats ANTHROPIC beats OPENAI beats codex OAuth beats CLAUDE_CODE_OAUTH_TOKEN).
- "No apiUrl/apiKey passed" → codex OAuth path is skipped entirely (proves the dual-use design: API-server callers without HTTP context fall through to env-only).
- "With apiUrl/apiKey but codex OAuth not configured" → `getValidCodexOAuth` returns null, falls through to CLAUDE_CODE_OAUTH_TOKEN.

**New file**: `src/tests/internal-ai/complete-structured.test.ts`:
- Mock `complete()` to return an `AssistantMessage` with a `tool_call` content block matching zod schema → expect parsed object returned, no retries.
- Mock `complete()` to return text only (no tool_call) for 3 calls → expect 3 invocations, return `null`, expect one `console.error`.
- Mock `complete()` to return a `tool_call` with bad shape on call 1, good shape on call 2 → expect 2 invocations, return parsed object.
- `claude-cli` kind: inject `_spawnClaudeCli` to return canned JSON → assert correct argv was constructed (no need to actually spawn).
- `cred === null` → return `null` without invoking `complete`.

**New file**: `src/tests/internal-ai/summarize-session.test.ts`:
- Inject `_completeStructured` returning a known `SummaryWithRatings` → assert pass-through.
- Inject retrievals → assert `buildSummaryWithRatingsPrompt` is exercised (snapshot or substring check on the userPrompt passed to `completeStructured`).
- `transcript.length === 50` → wrapper returns `null` (skip degenerate input).

**New file**: `src/tests/internal-ai/schema-parity.test.ts`:
- Fixture: 10 valid `SummaryWithRatings` shapes + 10 invalid → assert `SummaryWithRatingsSchema.safeParse` and `Value.Check(summaryToolSchema, x)` agree on every fixture.

#### 5. Hard rules verification

- No `import.*from.*"bun:sqlite"` anywhere under `src/utils/internal-ai/` — checked by `scripts/check-db-boundary.sh` and a new test that greps the directory.
- `typebox` is a transitive dep via pi-ai; confirm with `bun pm ls typebox` before adding to `package.json`. The package name is `typebox`, NOT `@sinclair/typebox` (pi-ai pins `"typebox": "^1.1.24"`). If we end up adding as a direct dep, that's not a version bump but does require lockfile commit.

### Success Criteria:

#### Automated Verification:
- [x] Phase 0 unit tests pass: `bun test src/tests/internal-ai/` (44 pass / 0 fail)
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint` (warnings only; exit 0)
- [x] DB-boundary check passes: `bash scripts/check-db-boundary.sh`
- [x] No lockfile drift: `bun install --frozen-lockfile` (run after any `package.json` edit)
- [x] `grep -r "bun:sqlite" src/utils/internal-ai/` returns zero matches. (Doc-comments mention the term; `grep -rE "from\s+[\"']bun:sqlite"` confirms zero real imports.)

#### Automated QA:
- [x] **Credential resolver matrix** (sub-agent): import `resolveCredential`, mock env vars one combination at a time (just OPENROUTER, just ANTHROPIC, both, codex-OAuth-only, CLAUDE_CODE_OAUTH_TOKEN-only, none), print the resolved `{kind, modelDefault}` table. Assert against expected precedence. — Covered by `src/tests/internal-ai/credentials.test.ts`.
- [x] **End-to-end happy path with real OpenRouter** (gated on `OPENROUTER_API_KEY`): a test calls `summarizeSession({harness:"pi", transcript:"<minimal real transcript>", retrievals:[], taskContext:{sourceTaskId:"t1",agentId:"a1"}})` and asserts the returned object has a non-empty `summary` field. `describe.skipIf(!process.env.OPENROUTER_API_KEY)` so CI doesn't require the key.

#### Manual Verification:
- [ ] Read `src/utils/internal-ai/credentials.ts` and confirm the codex-OAuth shape reshaping (`{access, refresh, expires} → { "openai-codex": creds }`) matches pi-ai's `getOAuthApiKey` expectation.

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 0] add internal-ai structured-output abstraction + extract BASE_SUMMARIZE_PROMPT`.

---

## Phase 1: Pi — replace `claude -p` shellout with summarizeSession

### Overview

Rewrite `src/providers/pi-mono-extension.ts:280-376` to call `summarizeSession` from Phase 0 instead of `Bun.spawn(claude -p)`. Keep the existing length/quality gate and `/api/memory/index` POST. Add `postRatings` mirroring claude's hook. Stop swallowing errors silently.

### Changes Required:

#### 1. Rewrite `summarizeSession` body

**File**: `src/providers/pi-mono-extension.ts`
**Changes**:
- **Delete**:
  - Lines 307-324 (inline `summarizePrompt` literal — the new helper builds it).
  - Lines 326-327 (tmpfile write).
  - Lines 328-351 (`Bun.spawn → claude -p`, timeout, stdout read, JSON parse, rm).
- **Add imports** at top of file:
  ```ts
  import { summarizeSession as runSummarize } from "../utils/internal-ai";
  import { fetchRetrievalsForTask, postRatings, buildRatingsFromLlm } from "../be/memory/raters/llm";
  ```
  (Rename the import to `runSummarize` to avoid colliding with the local `summarizeSession` function name; OR rename the local function to `summarizeSessionForPi` — pick one during impl.)
- **New function body** (replaces `pi-mono-extension.ts:280-376`):
  ```ts
  async function summarizeSession(config: SwarmConfig, sessionFile: string | undefined): Promise<void> {
    if (!sessionFile) return;
    try {
      const transcriptRaw = await Bun.file(sessionFile).text();
      const transcript = transcriptRaw.slice(-20_000);
      if (transcript.length <= 100) return;

      // `fetchTaskDetails` already exists in this file at pi-mono-extension.ts:70.
      const taskContext = await fetchTaskDetails(config).catch(() => undefined);
      const sourceTaskId = config.taskId;
      const agentId = config.agentId;
      if (!sourceTaskId || !agentId) return;

      const memoryRaters = (process.env.MEMORY_RATERS ?? "").split(",").map(s => s.trim());
      const wantRatings = memoryRaters.includes("llm");
      const retrievals = wantRatings
        ? await fetchRetrievalsForTask({ apiUrl: config.apiUrl, apiKey: config.apiKey, agentId, taskId: sourceTaskId }).catch(() => [])
        : [];

      const result = await runSummarize({
        harness: "pi",
        transcript,
        retrievals,
        taskContext: { sourceTaskId, agentId, prompt: taskContext?.prompt },
        apiUrl: config.apiUrl,
        apiKey: config.apiKey,
      });
      if (!result) return; // no auth resolved or wrapper gave up — already logged inside

      const summary = result.summary.trim();
      if (summary.length <= 20 || summary.toLowerCase().includes("no significant learnings")) return;

      const indexResp = await fetch(`${config.apiUrl}/api/memory/index`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
          "X-Agent-ID": agentId,
        },
        body: JSON.stringify({
          scope: "agent",
          source: "session_summary",
          sourceTaskId,
          content: summary,
          name: "session-summary",
          agentId,
        }),
      });
      if (!indexResp.ok) {
        console.error("session_summary: /api/memory/index POST failed (pi):", indexResp.status, await indexResp.text());
        return;
      }
      const indexed = await indexResp.json() as { memoryId: string };

      if (wantRatings && result.ratings?.length) {
        const ratingEvents = buildRatingsFromLlm(result.ratings, retrievals);
        await postRatings({
          apiUrl: config.apiUrl,
          apiKey: config.apiKey,
          agentId,
          memoryId: indexed.memoryId,
          ratings: ratingEvents,
        }).catch((err) => console.error("session_summary: postRatings failed (pi):", err));
      }
    } catch (err) {
      console.error("session_summary failed (pi):", err); // replaces silent catch at :373
    }
  }
  ```

#### 2. Test coverage

**File**: `src/tests/pi-mono-extension.test.ts` (new — verify no existing pi-mono test file first with `ls src/tests/pi-mono*`; if absent, create from scratch using `bun:test`'s `mock.module` pattern as seen in `src/tests/opencode-adapter.test.ts:73-78`)

**Test cases**:
- Happy path: write a temp file with a long transcript; mock `runSummarize` to return `{summary: "Learned X", ratings: []}`; mock `globalThis.fetch` to capture POST. Assert POST URL is `${apiUrl}/api/memory/index`, body has expected fields, no `console.error`.
- Empty transcript: temp file ≤100 chars → assert no POST, no exception.
- No credentials: mock `runSummarize` to return `null` → assert no POST, no exception, no error log (graceful no-op).
- Length gate: mock summary `"too short"` → assert no POST.
- "no significant learnings" gate: mock summary `"No significant learnings extracted."` → assert no POST.
- POST failure: mock fetch to return 500 → assert `console.error("session_summary: /api/memory/index POST failed (pi):"`).
- Exception path: mock fetch to throw → assert `console.error("session_summary failed (pi):"`).
- Ratings path: mock `MEMORY_RATERS=llm` + retrievals returned + non-empty ratings → assert `postRatings` called with expected shape.

#### 3. Update `session_shutdown` caller if needed

**File**: `src/providers/pi-mono-extension.ts` (lines 639-672 — the `session_shutdown` handler)
**Changes**: No changes required if the function name stays `summarizeSession`. If renamed to `summarizeSessionForPi`, update the call site at `:664`. The `SKIP_SESSION_SUMMARY` gate at `:663-665` stays as-is.

### Success Criteria:

#### Automated Verification:
- [x] Pi extension tests pass: `bun test src/tests/pi-mono-extension.test.ts` (9 pass / 0 fail)
- [x] Full unit suite passes: `bun test` (3690 pass / 0 fail)
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint` (exit 0; pre-existing warnings only)
- [x] DB-boundary check passes: `bash scripts/check-db-boundary.sh`
- [x] `grep -n "Bun.spawn" src/providers/pi-mono-extension.ts` returns zero matches in code (1 doc-comment mention of the removed shellout remains by design).

#### Automated QA:
- [ ] **Real pi session against local API server** (sub-agent): bring up the stack with `bun run pm2-start`, set `OPENROUTER_API_KEY`, create a pi task that does a small piece of real work, wait for completion, then `GET /api/memory/list?source=session_summary&taskId=<id>` and assert a non-empty row. Capture the memory id and content for the report.
- [ ] **Silent-fail regression check** (sub-agent): unset all credentials (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`), run a pi task. Confirm exactly one `console.error` line in worker logs (no stack-trace flood, no retries).

#### Manual Verification:
- [ ] Skim the indexed `content` from the happy-path memory: confirm it reads as a coherent session summary, not garbled tool output. If it looks degraded vs the old (broken) path's hypothetical output, the prompt may need tuning — that's a follow-up, not this plan.

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 1] pi: migrate session summarization to internal-ai`.

---

## Phase 2: Opencode — source transcript via SDK, migrate to wrapper

### Overview

Rewrite `plugin/opencode-plugins/agent-swarm.ts:236-332` to pull the transcript from opencode's SDK at `session.idle` time (option (a) — `_input.client.session.messages({ path: { id: sessionID } })`), then call `summarizeSession` from Phase 0. Deletes the dead-code branch at line 240 and the unreachable `claude -p` shellout at line 288.

### Changes Required:

#### 1. Wire SDK `client` through to the summarizer

**File**: `plugin/opencode-plugins/agent-swarm.ts`
**Changes**:
- Line 334 — replace `(_input) => ({` with `(input) => { const { client } = input; return ({`. Adjust matching brace/paren at the end of the `event:` registration block (around line 450).
- Lines 362-377 — replace the `session.idle` branch's `void summarizeSession(config, undefined);` (line 369) with `void summarizeSessionForOpencode(config, client, event.properties.sessionID);`.

#### 2. Replace function body

**File**: `plugin/opencode-plugins/agent-swarm.ts`
**Changes**:
- **Rename**: top-level `summarizeSession` → `summarizeSessionForOpencode` (avoid name collision with the wrapper import).
- **Delete**: lines 236-332 wholesale.
- **Add** new function and a `flattenOpencodeTranscript` helper:
  ```ts
  import type { PluginInput } from "@opencode-ai/plugin";
  import type { Message, Part } from "@opencode-ai/sdk";
  import { summarizeSession as runSummarize } from "@desplega.ai/agent-swarm/utils/internal-ai";
  // NOTE: the plugin is bundled separately — verify the import path resolves under `Dockerfile.worker:244-252`'s plugin copy. May need to materialize as a relative path or vendor a copy.
  import { fetchRetrievalsForTask, postRatings, buildRatingsFromLlm } from "@desplega.ai/agent-swarm/be/memory/raters/llm";

  async function summarizeSessionForOpencode(
    config: SwarmConfig,
    client: PluginInput["client"],
    sessionID: string,
  ): Promise<void> {
    try {
      const resp = await client.session.messages({ path: { id: sessionID } });
      const items: Array<{ info: Message; parts: Part[] }> = resp.data ?? resp; // verify shape from sdk.gen.d.ts:170
      const transcript = flattenOpencodeTranscript(items).slice(-20_000);
      if (transcript.length <= 100) return;

      // `fetchTaskDetails` already exists in this plugin at agent-swarm.ts:87.
      const taskContext = await fetchTaskDetails(config).catch(() => undefined);
      const sourceTaskId = config.taskId;
      const agentId = config.agentId;
      if (!sourceTaskId || !agentId) return;

      const memoryRaters = (process.env.MEMORY_RATERS ?? "").split(",").map(s => s.trim());
      const wantRatings = memoryRaters.includes("llm");
      const retrievals = wantRatings
        ? await fetchRetrievalsForTask({ apiUrl: config.apiUrl, apiKey: config.apiKey, agentId, taskId: sourceTaskId }).catch(() => [])
        : [];

      const result = await runSummarize({
        harness: "opencode",
        transcript,
        retrievals,
        taskContext: { sourceTaskId, agentId, prompt: taskContext?.prompt },
        apiUrl: config.apiUrl,
        apiKey: config.apiKey,
      });
      if (!result) return;

      const summary = result.summary.trim();
      if (summary.length <= 20 || summary.toLowerCase().includes("no significant learnings")) return;

      const indexResp = await fetch(`${config.apiUrl}/api/memory/index`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
          "X-Agent-ID": agentId,
        },
        body: JSON.stringify({
          scope: "agent",
          source: "session_summary",
          sourceTaskId,
          content: summary,
          name: "session-summary",
          agentId,
        }),
      });
      if (!indexResp.ok) {
        console.error("session_summary: /api/memory/index POST failed (opencode):", indexResp.status, await indexResp.text());
        return;
      }
      const indexed = await indexResp.json() as { memoryId: string };

      if (wantRatings && result.ratings?.length) {
        const ratingEvents = buildRatingsFromLlm(result.ratings, retrievals);
        await postRatings({
          apiUrl: config.apiUrl,
          apiKey: config.apiKey,
          agentId,
          memoryId: indexed.memoryId,
          ratings: ratingEvents,
        }).catch((err) => console.error("session_summary: postRatings failed (opencode):", err));
      }
    } catch (err) {
      console.error("session_summary failed (opencode):", err);
    }
  }

  function flattenOpencodeTranscript(items: Array<{ info: Message; parts: Part[] }>): string {
    const lines: string[] = [];
    for (const { info, parts } of items) {
      const role = info.role === "user" ? "User" : "Assistant";
      for (const part of parts) {
        if (part.type === "text") {
          lines.push(`${role}: ${part.text}`);
        } else if (part.type === "tool") {
          const tool = (part as any).tool ?? "tool";
          const state = (part as any).state;
          if (state && state.status === "completed") {
            const input = JSON.stringify(state.input ?? {}).slice(0, 500);
            const output = JSON.stringify(state.output ?? {}).slice(0, 1000);
            lines.push(`Tool[${tool}]: input=${input} output=${output}`);
          }
        }
        // ignore reasoning, file, step-start, step-finish, snapshot, patch, agent, retry, compaction
      }
    }
    return lines.join("\n");
  }
  ```

#### 3. Opencode `auth.json` resolver — separate function, NOT inside `resolveCredential`

**Design constraint**: Phase 0's `resolveCredential` is harness-agnostic (`// "No `harness` check"` rule at L188). To preserve that invariant, opencode auth resolution is a **separate, opencode-only function** that the plugin calls BEFORE falling back to `resolveCredential`. This keeps the lower layer dual-use (worker + API server) while letting opencode read its provider-specific auth store.

**New file**: `plugin/opencode-plugins/opencode-auth.ts` (lives next to the plugin so it's bundled together — NOT in `src/utils/internal-ai/`).

**Exports**:
```ts
import { getOAuthApiKey } from "@mariozechner/pi-ai";
import type { ResolvedCredential } from "@desplega.ai/agent-swarm/utils/internal-ai/credentials";

/**
 * Read ~/.local/share/opencode/auth.json and resolve a usable credential.
 * Returns null if no auth file, no mapped provider, or all entries unusable.
 * On OAuth refresh, MUST persist refreshed credentials back to auth.json — see step 4 below.
 */
export async function resolveOpencodeAuth(): Promise<ResolvedCredential | null>;
```

Behavior:
- Read `~/.local/share/opencode/auth.json` (`Bun.file(path).json().catch(() => null)`).
- Parse as `Record<providerID, OAuth|ApiAuth|WellKnownAuth>` per `node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts:1458-1474`.
- Map opencode provider IDs to pi-ai `CredentialKind`:
  - `"anthropic"` → `"anthropic"`
  - `"openrouter"` → `"openrouter"`
  - `"openai"` → `"openai"`
  - (others: ignore for now — add a `// TODO` comment listing the unmapped providers)
- Precedence order across providers: openrouter > anthropic > openai.
- For each provider in precedence order, try in this order:
  - `ApiAuth.key` → return as `{kind, apiKey, modelDefault: DEFAULT_MODEL[kind]}`.
  - `OAuth{refresh, access, expires}` → reshape to `{ [providerID]: creds }`, call `getOAuthApiKey(providerID, map)`. **Handle `newCredentials`** — see step 4.
  - `WellKnownAuth` → use the `token` as apiKey.
- If nothing resolves, return `null`.

#### 4. Persist OAuth `newCredentials` back to `auth.json`

When `getOAuthApiKey` returns `{newCredentials, apiKey}`, write `newCredentials` back into the same provider slot in `~/.local/share/opencode/auth.json` before returning. Without this step, the refresh token rotates silently in-memory and is lost on the next session, causing future `getOAuthApiKey` calls to fail with the stale credentials. Wrap the file write in try/catch + `console.error` — persistence failure should NOT block the current call from returning a usable `apiKey`.

**Plugin call site** (Phase 2 step 2 `summarizeSessionForOpencode`): try `resolveOpencodeAuth()` first; if non-null, pass the resolved credential into a new `_credentialOverride` option on `completeStructured` so it skips its own resolver. If null, fall through to the default resolver via `apiUrl`/`apiKey`.

**Phase 0 amendment**: add a `_credentialOverride?: ResolvedCredential` option to `CompleteStructuredOptions`. When set, skip `resolveCredential` entirely. This is the clean injection point that keeps the lower layer harness-agnostic.

Add unit tests in `plugin/opencode-plugins/tests/opencode-auth.test.ts` (NEW file, separate from Phase 0's `internal-ai/credentials.test.ts`):
- `~/.local/share/opencode/auth.json` with `anthropic: {type:"api", key:"sk-..."}` → `{kind: "anthropic", apiKey: "sk-..."}`.
- Mix of OAuth + api auth → api wins per precedence (avoids OAuth refresh complexity in tests).
- OAuth path returns refreshed `newCredentials` → assert the file is rewritten with the new value (see step 4).
- Missing auth.json → returns `null`.

#### 4. Test coverage

**File**: `src/tests/opencode-plugin.test.ts` (new — model after `src/tests/opencode-adapter.test.ts` `mock.module` pattern at `:73-78`)

**Test cases**:
- `flattenOpencodeTranscript` snapshot: fixture with user TextPart, assistant TextPart, ToolPart (completed with command output), assistant TextPart → expected multi-line string.
- Plugin happy path: build a fake `PluginInput` with `client.session.messages` returning a canned `Array<{info, parts}>`; trigger the `event` hook manually with `{type:"session.idle", properties:{sessionID:"test-123"}}`; mock `runSummarize` to return a known `SummaryWithRatings`; mock `globalThis.fetch` to capture POST. Assert POST body shape.
- Empty messages → no POST, no error.
- `client.session.messages` throws → exactly one `console.error("session_summary failed (opencode):", ...)`.

### Success Criteria:

#### Automated Verification:
- [x] Opencode plugin tests pass: `bun test src/tests/opencode-plugin.test.ts`
- [x] Full unit suite passes: `bun test`
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint`
- [x] DB-boundary check passes: `bash scripts/check-db-boundary.sh`
- [x] Docker worker still builds: `bun run docker:build:worker` (the plugin is bundled in — confirm path resolution works inside the worker image)
- [x] **Plugin import path hard gate**: bundling the opencode plugin MUST successfully resolve `@desplega.ai/agent-swarm/utils/internal-ai` and `@desplega.ai/agent-swarm/be/memory/raters/llm`. Verify by running the plugin bundle step (whatever `Dockerfile.worker:244-252` runs) and confirming the resulting JS contains references to `internal-ai` symbols. If resolution fails, fall back to one of: (a) vendor the helpers into `plugin/opencode-plugins/`, (b) add an esbuild alias mapping the package paths to repo-local sources. Do not ship Phase 2 with an unresolved import. **Resolved (a): the agent-swarm package is not resolvable inside opencode's bundled-Bun plugin runtime; vendored minimal helpers into `plugin/opencode-plugins/lib/{summarize,opencode-auth}.ts` and updated `Dockerfile.worker` to COPY the whole `lib/` directory.**
- [x] `grep -n "claude -p\|Bun.spawn" plugin/opencode-plugins/agent-swarm.ts` returns zero matches.

#### Automated QA:
- [x] **Real opencode session** (sub-agent): bring up the stack, set `OPENROUTER_API_KEY` (or populate `~/.local/share/opencode/auth.json`), create an opencode task, wait for completion, assert a `session_summary` row exists for the task.
- [x] **Plugin import path verification**: have the sub-agent run `docker run --rm <worker-image> sh -c 'cat /home/worker/.opencode/swarm/agent-swarm.js | grep -c "summarizeSessionForOpencode"'` — confirm the bundled plugin includes the new function. (Actual path: `/home/worker/.config/opencode/plugins/agent-swarm.ts`. `summarizeSessionForOpencode` is imported and invoked on `session.idle` — see line 16, line 264.)

#### Manual Verification:
- [ ] Inspect `flattenOpencodeTranscript` output from a real session: confirm tool calls + text alternations read coherently (not garbled JSON).

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 2] opencode: source transcript via SDK + migrate to internal-ai`.

---

## Phase 3: Codex — buffer transcript in adapter, add summarize call

### Overview

Add a `private transcript: string[]` instance field on `CodexAdapter`. Append in `handleEvent` cases (`item.completed → agent_message`, `item.started → tool_start`, `item.completed → tool_end`). Seed with the resolved user prompt at session start. In the `runSession` finally-block at `src/providers/codex-adapter.ts:829-838`, call `summarizeSession`. Codex previously had no summary path at all — pure addition, no behavior to preserve.

### Changes Required:

#### 1. Transcript buffer on the adapter

**File**: `src/providers/codex-adapter.ts`
**Changes**:
- Near other per-session state declarations (`numTurns`, `lastUsage` around lines 365-367), add:
  ```ts
  private transcript: string[] = [];
  ```
- In `runSession`, right before `await this.thread.runStreamed(resolvedPrompt, ...)` (around lines 765-770), reset + seed:
  ```ts
  this.transcript = [`User: ${resolvedPrompt}`];
  ```
- In `handleEvent`:
  - `case "item.started":` tool branch (around `:577-587`): inside the existing `if (this.isToolItem(event.item))` block, after `this.emit(...)`, also:
    ```ts
    this.transcript.push(
      `Tool[${this.toolNameForItem(event.item)}] started: ${JSON.stringify(this.toolArgsForItem(event.item)).slice(0, 500)}`,
    );
    ```
  - `case "item.completed":` tool branch (around `:611-619`): after `this.emit({type:"tool_end", ...})`, also:
    ```ts
    this.transcript.push(
      `Tool[${this.toolNameForItem(item)}] completed: ${this.shortenItemResult(item)}`,
    );
    ```
  - `case "item.completed":` `agent_message` branch (around `:621-627`): after `this.emit({type:"message", role:"assistant", content: msg.text})`, also:
    ```ts
    this.transcript.push(`Assistant: ${msg.text}`);
    ```
- Add a private helper:
  ```ts
  private shortenItemResult(item: any): string {
    // Pick the most signal-dense fields per tool type without dumping full JSON.
    if (item.type === "command_execution") {
      return `exit=${item.exit_code ?? "?"} stdout=${(item.stdout ?? "").slice(0, 500)}`;
    }
    if (item.type === "file_change") {
      return `path=${item.path ?? "?"} op=${item.operation ?? "?"}`;
    }
    if (item.type === "mcp_tool_call") {
      return `result=${JSON.stringify(item.result ?? {}).slice(0, 500)}`;
    }
    return JSON.stringify(item).slice(0, 500);
  }
  ```
  (Refine the field names during impl by inspecting `src/providers/codex-adapter.ts:577-668` and the codex SDK's item types.)

#### 2. Summarize at finally

**File**: `src/providers/codex-adapter.ts`
**Changes** (lines 829-838 finally-block):

Insert before the existing cleanup. Wrap in its own try so summary failure does NOT block existing log/AGENTS.md cleanup:

```ts
} finally {
  // NEW: session summarization
  if (process.env.SKIP_SESSION_SUMMARY !== "1") {
    try {
      const transcriptStr = this.transcript.join("\n").slice(-20_000);
      const { agentId, taskId, apiUrl, apiKey } = this.config;
      if (transcriptStr.length > 100 && agentId && taskId && apiUrl && apiKey) {
        const memoryRaters = (process.env.MEMORY_RATERS ?? "").split(",").map(s => s.trim());
        const wantRatings = memoryRaters.includes("llm");
        const retrievals = wantRatings
          ? await fetchRetrievalsForTask({ apiUrl, apiKey, agentId, taskId }).catch(() => [])
          : [];
        const result = await runSummarize({
          harness: "codex",
          transcript: transcriptStr,
          retrievals,
          taskContext: { sourceTaskId: taskId, agentId, prompt: this.config.prompt },
          apiUrl,
          apiKey,
        });
        if (result) {
          const summary = result.summary.trim();
          if (summary.length > 20 && !summary.toLowerCase().includes("no significant learnings")) {
            const indexResp = await fetch(`${apiUrl}/api/memory/index`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
                "X-Agent-ID": agentId,
              },
              body: JSON.stringify({
                scope: "agent",
                source: "session_summary",
                sourceTaskId: taskId,
                content: summary,
                name: "session-summary",
                agentId,
              }),
            });
            if (!indexResp.ok) {
              console.error("session_summary: /api/memory/index POST failed (codex):", indexResp.status);
            } else if (wantRatings && result.ratings?.length) {
              const indexed = await indexResp.json() as { memoryId: string };
              const ratingEvents = buildRatingsFromLlm(result.ratings, retrievals);
              await postRatings({ apiUrl, apiKey, agentId, memoryId: indexed.memoryId, ratings: ratingEvents })
                .catch((err) => console.error("session_summary: postRatings failed (codex):", err));
            }
          }
        }
      }
    } catch (err) {
      console.error("session_summary failed (codex):", err);
    }
  }

  // EXISTING cleanup (do not change):
  this.abortRef.current = null;
  try {
    await this.logFileHandle.end();
  } catch {
    // Ignore log writer cleanup failures.
  }
  await this.agentsMdHandle.cleanup();
}
```

Imports at top of file:
```ts
import { summarizeSession as runSummarize } from "../utils/internal-ai";
import { fetchRetrievalsForTask, postRatings, buildRatingsFromLlm } from "../be/memory/raters/llm";
```

#### 3. Test coverage

**File**: `src/tests/codex-adapter.test.ts` (extend existing)

**Test cases**:
- Reuse `makeFakeThread` at `:34-52`. Build an event sequence:
  1. `thread.started` (`thread_id: "t1"`)
  2. `turn.started`
  3. `item.started` for a `command_execution` tool with args `{cmd: "ls"}`
  4. `item.completed` for that tool with `{exit_code: 0, stdout: "file1\nfile2"}`
  5. `item.completed` for an `agent_message` with `text: "I listed the files."`
  6. `turn.completed` with usage
- Mock `globalThis.fetch` to capture POSTs to `/api/memory/index`.
- Inject a stub `runSummarize` (via `mock.module("../utils/internal-ai", ...)`) that returns `{summary: "Listed files", ratings: []}`.
- After `waitForCompletion`, assert:
  - `runSummarize` called once with `harness: "codex"`, transcript containing `User: <prompt>`, `Tool[command_execution] started`, `Tool[command_execution] completed`, `Assistant: I listed the files.`.
  - `/api/memory/index` POST captured with the expected body.
- Edge: `process.env.SKIP_SESSION_SUMMARY = "1"` → no `runSummarize` call, no POST. (Use `beforeEach`/`afterEach` to manage env.)
- Edge: `config.taskId === undefined` → no `runSummarize` call.
- Edge: throw inside `runSummarize` → existing `logFileHandle.end()` and `agentsMdHandle.cleanup()` still run (assert via spy on each).

### Success Criteria:

#### Automated Verification:
- [x] Codex adapter tests pass: `bun test src/tests/codex-adapter.test.ts`
- [x] Full unit suite passes: `bun test`
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint`
- [x] DB-boundary check passes: `bash scripts/check-db-boundary.sh`

#### Automated QA:
- [x] **Real codex session against local API server** (sub-agent): bring up the stack with codex OAuth configured (`bun run src/cli.tsx codex-oauth-login` per `thoughts/taras/plans/2026-04-10-codex-oauth-support.md`), create a codex task, wait for completion, assert a `session_summary` row exists.
- [x] **Env fallback path** (sub-agent): same as above but with `OPENAI_API_KEY` env set and no codex OAuth → confirm summary still indexed (the wrapper falls through env precedence).
- [x] **Cleanup-after-failure** (in the unit test): inject a fault that makes `runSummarize` reject, assert `agentsMdHandle.cleanup()` still runs.

#### Manual Verification:
- [ ] On a real codex session, eyeball the indexed `session_summary` content for coherence (codex transcript is event-buffered rather than file-sourced; quality may differ from claude's). If garbled, refine `shortenItemResult`.

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 3] codex: buffer transcript + add session summarization`.

---

## Phase 4: Claude — migrate Stop hook to summarizeSession (with `CLAUDE_CODE_OAUTH_TOKEN` fallback)

### Overview

Rewrite `src/hooks/hook.ts:1043-1222` (claude's Stop branch) to call `summarizeSession` from Phase 0 instead of `runMemoryRater`. The wrapper's credential resolver handles the `CLAUDE_CODE_OAUTH_TOKEN → claude -p` fallback automatically, so Pro/Max OAuth users keep working without OpenRouter. Touches the working path last, gated on phases 0–3 passing.

### Changes Required:

#### 1. Rewrite the Stop branch

**File**: `src/hooks/hook.ts`
**Changes**:
- **Remove import**: `runMemoryRater` (currently imported from `src/be/memory/raters/llm-summarizer`). Keep `fetchRetrievalsForTask`, `postRatings`, `buildRatingsFromLlm`, `BASE_SUMMARIZE_PROMPT` (extracted in Phase 0), `buildSummaryWithRatingsPrompt` (no longer used here directly — the wrapper builds the prompt internally; remove if unused).
- **Add import**: `summarizeSession as runSummarize` from `src/utils/internal-ai`.
- **Modify gate at lines 1089-1094**: drop the `OPENROUTER_API_KEY` requirement — the wrapper handles credential resolution and returns `null` if nothing resolves. Keep `agentInfo?.id`, `msg.transcript_path`, `!SKIP_SESSION_SUMMARY` checks.
- **Modify lines 1095-1170** (prompt build + LLM call):
  - Keep transcript read at lines 1098-1100 (last 20 KB).
  - Keep `fetchRetrievalsForTask` at line 1126 (still useful — but now passed into the wrapper, not directly into the prompt).
  - Replace lines 1132-1170 with:
    ```ts
    const result = await runSummarize({
      harness: "claude",
      transcript,
      retrievals,
      taskContext: {
        sourceTaskId,
        agentId: agentInfo.id,
        prompt: undefined, // claude's path doesn't pass the user prompt here today; leave undefined
      },
      apiUrl: MCP_BASE_URL,
      apiKey: API_KEY,
    });
    if (!result) return; // no auth resolved (no OPENROUTER, no ANTHROPIC, no OPENAI, no CLAUDE_CODE_OAUTH_TOKEN) — silent skip, same as today's no-key behavior
    const summary = result.summary.trim();
    const ratings = result.ratings ?? [];
    ```
- **Keep**: lines 1171-1214 (length gate + `/api/memory/index` POST + `postRatings`). The wrapper returns the same shape `runMemoryRater` did, so the downstream POST logic is unchanged.

#### 2. Verify `CLAUDE_CODE_OAUTH_TOKEN` fallback path is exercised

**File**: `src/tests/internal-ai/credentials.test.ts` (extend Phase 0's file)
**Changes**: Add an explicit test:
```ts
test("CLAUDE_CODE_OAUTH_TOKEN-only env → claude-cli kind", async () => {
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-test-oauth";
  const resolved = await resolveCredential({ env: process.env, callerTag: "claude-stop-hook" });
  expect(resolved?.kind).toBe("claude-cli");
  expect(resolved?.modelDefault).toBe("haiku");
});
```

#### 3. Test coverage

**File**: `src/tests/claude-stop-hook.test.ts` (new — grep `src/tests/hook*.test.ts` first to confirm no overlap; if a hook test already exists, extend it)

**Test cases**:
- Provide a fake `msg.transcript_path` pointing to a `bun:test` temp file with transcript content.
- Mock `runSummarize` (via `mock.module`) to return `{summary: "Learned X", ratings: []}`.
- Mock `globalThis.fetch` to capture POSTs.
- Assert `/api/memory/index` POST body matches what the old `runMemoryRater` path produced (shape, not exact content): `source: "session_summary"`, non-empty `content`, expected scope/sourceTaskId/agentId.
- Edge: no credentials at all → `runSummarize` returns `null` → no POST, no exception.
- Edge: only `CLAUDE_CODE_OAUTH_TOKEN` set → wrapper goes through `claude-cli` path. Mock the `_spawnClaudeCli` injection point to return canned JSON; assert the POST still happens.
- Edge: `SKIP_SESSION_SUMMARY=1` → no `runSummarize`, no POST.

### Success Criteria:

#### Automated Verification:
- [x] Claude Stop hook tests pass: `bun test src/tests/claude-stop-hook.test.ts`
- [x] Full unit suite passes: `bun test`
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint`
- [x] DB-boundary check passes: `bash scripts/check-db-boundary.sh`

#### Automated QA:
- [ ] **`CLAUDE_CODE_OAUTH_TOKEN`-only fallback** (sub-agent): bring up the stack with ONLY `CLAUDE_CODE_OAUTH_TOKEN` set (no OpenRouter/Anthropic/OpenAI keys). Run a claude task. Assert a `session_summary` row is produced via the `claude -p` fallback path. Verify by tailing worker logs for a line like `internal-ai: kind=claude-cli` (add this log in Phase 0).
- [x] **OpenRouter precedence** (sub-agent): same with `OPENROUTER_API_KEY` also set → confirm the OpenRouter path takes precedence (the `claude-cli` shellout is NOT invoked — verify by absence of `kind=claude-cli` log line and presence of `kind=openrouter`).

#### Manual Verification:
- [ ] Compare a Phase 4 claude `session_summary` row (via wrapper, OpenRouter path) to a pre-Phase 4 row (via old `runMemoryRater`): content quality should be equivalent. If degraded, investigate the typebox tool-call schema vs the old `response_format: json_schema` approach (the tool-call retry loop may help or hurt — eyeball a few examples).

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 4] claude: migrate Stop hook to internal-ai with CLAUDE_CODE_OAUTH_TOKEN fallback`.

---

## Phase 5: Cleanup — narrow deletions only (`ClaudeCliLlmRaterClient` + `runMemoryRater`) — **CANCELLED**

> **Status: CANCELLED (2026-05-11).** During execution the Phase 5 pre-check (see §1 below) confirmed the documented blocker: `src/be/memory/raters/llm.ts:20` imports `ClaudeCliLlmRaterClient` from `llm-client.ts` and `LlmRater`'s constructor uses it as a default at `:97` — so `llm-client.ts` cannot be deleted without modifying `LlmRater` itself, which v4 errata explicitly defers to **[DES-363](https://linear.app/desplega-labs/issue/DES-363/migrate-llmrater-to-completestructured-break-openrouter-hardcode)**. Phases 0–4 (the user-visible fix) shipped on branch `fix-session-summarization-workers`. All Phase 5 cleanup work (delete `llm-client.ts` + `llm-summarizer.ts`, sweep `MEMORY_LLM_RATER_PROVIDER`, soft-deprecation warning, runbook + CHANGELOG updates) is folded into DES-363.

### Overview

**Revised after review** (v3): the original Phase 5 deleted `LlmRater` based on a research mis-read. Prod evidence (digest: `llm` rater 461 events / 132 memories / 24h, plus `MEMORY_RATERS=implicit-citation,llm,explicit-self` in env) confirms `LlmRater` is alive and worker-driven. **`LlmRater` stays.** Phase 5 now only deletes the genuinely unused pieces: `ClaudeCliLlmRaterClient` (zero importers), `runMemoryRater` (claude-hook-only, migrated in Phase 4), and the `MEMORY_LLM_RATER_PROVIDER` env handling.

Migrating `LlmRater` itself onto `completeStructured` (and breaking its hardcoded OpenRouter dependency) is a **separate Linear issue** in the Swarm Bugs and Features project — out of scope for this plan because: (a) 461 events/day = real prod traffic with no acceptable downtime, (b) needs its own shadow-mode / A/B strategy, (c) merging it would balloon plan blast radius right when we want the session-summary fix to ship.

### Changes Required:

#### 1. Delete dead modules

**Files to delete**:
- `src/be/memory/raters/llm-client.ts` — zero production importers per research. **Pre-check before delete**: `grep -rn "from.*llm-client\|require.*llm-client\|getDefaultLlmRaterClient\|ClaudeCliLlmRaterClient" src/ plugin/` MUST return zero matches outside tests. If `LlmRater` transitively imports it, BLOCK Phase 5 and reassign to the LlmRater-migration plan.
- `src/be/memory/raters/llm-summarizer.ts` — only consumer was claude hook, migrated in Phase 4. **Pre-check**: `grep -rn "runMemoryRater\|llm-summarizer" src/ plugin/` outside tests should now return zero matches after Phase 4.
- `src/tests/memory-rater-llm.test.ts` — **conditional**: delete only if it tests `LlmRater.rate()` against `ClaudeCliLlmRaterClient`. If it tests `LlmRater`'s general behavior (which IS still alive), KEEP and just remove the client-specific cases.

#### 2. Trim `llm.ts` — narrowly

**File**: `src/be/memory/raters/llm.ts`
**Changes**:
- **Do NOT delete `LlmRater` class** (revised — was an error in v2). It's alive worker-side.
- Delete any imports of `LlmRaterClient` / `getDefaultLlmRaterClient` IF `LlmRater` no longer uses them. If it does, this is a blocker for Phase 5 — reassign to the LlmRater migration plan.
- **Keep**: `BASE_SUMMARIZE_PROMPT` (added Phase 0), `buildSummaryWithRatingsPrompt`, `buildRatingsFromLlm`, `SummaryWithRatingsSchema`, `fetchRetrievalsForTask`, `postRatings`, `LlmRater` class. These are consumed by `src/utils/internal-ai/summarize-session.ts`, the four migrated paths, AND the live worker-side LlmRater.

#### 3. Trim registry — leave `LlmRater` factory alone

**File**: `src/be/memory/raters/registry.ts`
**Changes**:
- **Do NOT remove** the `llm: () => new LlmRater()` factory entry at line 32 — it's the worker-side path Taras's prod relies on.
- `MEMORY_RATERS=llm` env should now warn-and-ignore (log once at server startup: `"MEMORY_RATERS=llm is deprecated; session summaries are handled by src/utils/internal-ai/. Remove this env var."`). Don't break startup — soft deprecation.

#### 4. Remove env handling

**File**: search-and-remove all `MEMORY_LLM_RATER_PROVIDER` references:
- `src/be/memory/raters/llm-client.ts:164` (file deleted in step 1)
- Any docs: `grep -r "MEMORY_LLM_RATER_PROVIDER" docs-site/ runbooks/ README.md MCP.md DEPLOYMENT.md CONTRIBUTING.md` — remove every match.

#### 5. Documentation updates

**File**: `runbooks/memory-system.md`
**Changes**:
- Update the "memory raters" section: `llm` is no longer a valid `MEMORY_RATERS` value (it never ran in production). Document the new path: session-summary now lives in `src/utils/internal-ai/summarize-session.ts`, fired by each provider's session-end hook. Add a small table mapping each harness to its call site.

**File**: `runbooks/harness-providers.md`
**Changes**:
- Add a "Session summarization" section. Per-harness call sites:
  - claude: `src/hooks/hook.ts:1043` (Stop hook)
  - pi: `src/providers/pi-mono-extension.ts:280` (`session_shutdown`)
  - opencode: `plugin/opencode-plugins/agent-swarm.ts:362` (`session.idle`)
  - codex: `src/providers/codex-adapter.ts:829` (`runSession` finally)
- All four route through `src/utils/internal-ai/summarize-session.ts`. Credential precedence: `OPENROUTER_API_KEY > ANTHROPIC_API_KEY > OPENAI_API_KEY > codex OAuth (codex only) > CLAUDE_CODE_OAUTH_TOKEN (fallback to claude -p)`.

**File**: `CHANGELOG.md`
**Changes**: Add a single entry under the next version describing the cleanup. Cross-reference #450.

#### 6. Test coverage

No new tests in this phase — the deletions are covered by:
- Phase 0–4 tests confirming the new code works.
- Existing tests that imported the deleted modules need updating: `grep -rln "llm-client\|llm-summarizer\|ClaudeCliLlmRaterClient\|runMemoryRater" src/` → for each match, either delete the test (if it was specific to the deleted module) or update it to use the new path. (Tests against `LlmRater` itself stay — that class is alive.)

### Success Criteria:

#### Automated Verification:
- [ ] Full unit suite passes: `bun test`
- [ ] Type check passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint`
- [ ] DB-boundary check passes: `bash scripts/check-db-boundary.sh`
- [ ] `grep -rn "runMemoryRater\|ClaudeCliLlmRaterClient\|MEMORY_LLM_RATER_PROVIDER\|llm-client\|llm-summarizer" src/ plugin/ docs-site/ runbooks/ MCP.md DEPLOYMENT.md CONTRIBUTING.md README.md` returns zero matches (excluding CHANGELOG history). **Note**: `LlmRater` is NOT in this grep — it stays alive in `llm.ts` and `registry.ts`.
- [ ] OpenAPI spec freshness: `bun run docs:openapi` is a no-op (no HTTP changes; sanity check that nothing slipped in).

#### Automated QA:
- [ ] **Cross-harness final smoke** (sub-agent): run one minimal task per harness (claude/pi/opencode/codex) against the local stack with `OPENROUTER_API_KEY` set; confirm all four produce a `session_summary` row. If any harness fails, the regression is in Phase 0–4; this cleanup phase is purely deletions.

#### Manual Verification:
- [ ] Skim updated `runbooks/memory-system.md` and `runbooks/harness-providers.md`: do they accurately describe the new path? Anything still mentioning `MEMORY_RATERS=llm` should be either updated or explicitly deprecated.

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 5] cleanup: remove dead ClaudeCliLlmRaterClient + runMemoryRater (LlmRater preserved)`.

---

## Manual E2E

Run against a fully-local stack (`bun run pm2-start` for API/UI/lead/worker, or `docker compose -f docker-compose.local.yml up --build` for the worker side). Reference: `LOCAL_TESTING.md` + `runbooks/local-development.md`.

**Common setup** (in repo root):

```bash
bun install --frozen-lockfile
bun run pm2-start
# Confirm:
curl -s http://localhost:3013/health
curl -sI http://localhost:5274
```

**Scenario 1 — Pi harness, OpenRouter auth**:

```bash
export OPENROUTER_API_KEY="sk-or-..."
bun run pm2-restart  # pick up the env

# Create a pi task:
TASK_ID=$(curl -sX POST http://localhost:3013/api/tasks \
  -H "Authorization: Bearer ${API_KEY:-123123}" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Read CLAUDE.md and summarize the architecture invariants in 3 bullets.","harness":"pi"}' | jq -r '.id')
echo "task: $TASK_ID"

# Poll until done:
until [ "$(curl -s "http://localhost:3013/api/tasks/$TASK_ID" -H "Authorization: Bearer ${API_KEY:-123123}" | jq -r '.status')" = "completed" ]; do sleep 5; done

# Assert summary row:
curl -s "http://localhost:3013/api/memory/list?source=session_summary&taskId=$TASK_ID" \
  -H "Authorization: Bearer ${API_KEY:-123123}" | jq '.memories[] | {id, name, content: (.content[:200])}'
# Expect: at least one row with non-empty content.
```

**Scenario 2 — Opencode harness, env auth**:

Same as Scenario 1 with `"harness":"opencode"`. Requires either env keys set OR `~/.local/share/opencode/auth.json` populated (per `docker-entrypoint.sh:29-31`).

**Scenario 3 — Codex harness, OAuth path**:

```bash
# One-time codex OAuth setup:
bun run src/cli.tsx codex-oauth-login

# Verify the token landed:
curl -s "http://localhost:3013/api/config/resolved?key=codex_oauth&includeSecrets=true" \
  -H "Authorization: Bearer ${API_KEY:-123123}" | jq '.configs[0] | {key, hasValue: (.value | length > 0)}'

# Unset env keys so the wrapper must use codex OAuth:
unset OPENROUTER_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY

# Run a codex task like Scenario 1 with "harness":"codex".
# Expect: session_summary row indexed via codex OAuth.
```

**Scenario 4 — Codex harness, OPENAI_API_KEY fallback**:

```bash
# Delete codex OAuth (via API) so only env auth is available:
curl -X DELETE "http://localhost:3013/api/config?key=codex_oauth" \
  -H "Authorization: Bearer ${API_KEY:-123123}"

export OPENAI_API_KEY="sk-..."
bun run pm2-restart

# Run a codex task as Scenario 3.
# Expect: session_summary indexed via env fallback (wrapper kind=openai).
```

**Scenario 5 — Claude harness, `CLAUDE_CODE_OAUTH_TOKEN` fallback (the most disruptive path)**:

```bash
unset OPENROUTER_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY
# CLAUDE_CODE_OAUTH_TOKEN must already be set (typical for Pro/Max OAuth users; see `claude login`)
echo "CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN:?must be set}"
bun run pm2-restart

# Run a claude task as Scenario 1 with "harness":"claude".
# Tail logs in parallel:
bun run pm2-logs | grep -E "internal-ai: kind=claude-cli|session_summary"
# Expect: at least one "kind=claude-cli" log line + a session_summary row.
```

**Scenario 6 — Negative path, no credentials**:

```bash
unset OPENROUTER_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY CLAUDE_CODE_OAUTH_TOKEN
curl -X DELETE "http://localhost:3013/api/config?key=codex_oauth" -H "Authorization: Bearer ${API_KEY:-123123}"
bun run pm2-restart

# Run a pi task.
# Expect:
#   - Task completes normally.
#   - NO session_summary row.
#   - Worker logs: exactly one warning per session (e.g. "session_summary skipped: no credentials resolved") — NOT a stack trace.
```

**Scenario 7 — Cross-harness smoke (final regression check)**:

```bash
export OPENROUTER_API_KEY="sk-or-..."
bun run pm2-restart

for HARNESS in claude pi opencode codex; do
  echo "=== $HARNESS ==="
  TASK_ID=$(curl -sX POST http://localhost:3013/api/tasks \
    -H "Authorization: Bearer ${API_KEY:-123123}" \
    -H "Content-Type: application/json" \
    -d "{\"prompt\":\"List files in pwd, then say done.\",\"harness\":\"$HARNESS\"}" | jq -r '.id')

  until [ "$(curl -s "http://localhost:3013/api/tasks/$TASK_ID" -H "Authorization: Bearer ${API_KEY:-123123}" | jq -r '.status')" = "completed" ]; do sleep 5; done

  ROWS=$(curl -s "http://localhost:3013/api/memory/list?source=session_summary&taskId=$TASK_ID" \
    -H "Authorization: Bearer ${API_KEY:-123123}" | jq '.memories | length')
  echo "  session_summary rows: $ROWS"
  [ "$ROWS" -ge 1 ] || { echo "  FAIL: no summary"; exit 1; }
done
echo "All four harnesses produced session_summary rows."
```

## Appendix

- **Follow-up plans**:
  - **API-server consumers of `completeStructured`**: migrate `src/workflows/executors/raw-llm.ts` + `validate.ts` onto the new abstraction. Convergence target: one structured-output helper for the entire codebase.
  - Migrate `src/commands/claude-managed-setup.ts:483` (Anthropic SDK call) — one-off, low priority.
  - **Memory `LlmRater` migration to `completeStructured`** — [DES-363](https://linear.app/desplega-labs/issue/DES-363/migrate-llmrater-to-completestructured-break-openrouter-hardcode). `LlmRater` is alive in prod (461 events / 132 memories rated per 24h) and currently hardcoded to OpenRouter. The new `completeStructured` abstraction would let it route through any of the configured providers (anthropic, openai, openai-codex OAuth, etc.) per the unified precedence. Out of scope for THIS plan because: (a) needs shadow-mode / A/B rollout, (b) per-rater throughput SLO needs preservation, (c) merging it would balloon the session-summary fix's blast radius.
  - Devin / claude-managed harness session summarization — different flow, intentionally deferred.
- **Derail notes**:
  - **typebox dep**: the npm package is `typebox` (NOT `@sinclair/typebox`) — pi-ai depends on `"typebox": "^1.1.24"` (verified in `node_modules/@mariozechner/pi-ai/package.json:75`). Confirm with `bun pm ls typebox` before adding to `package.json`. If added as a direct dep, that's not a version bump but does require a lockfile commit.
  - **`fetchRetrievalsForTask` / `postRatings` worker-safety**: assumed worker-safe (used by claude hook which runs in a worker subprocess). Phase 0 verifies; if they transitively pull `bun:sqlite`, lift the HTTP-only helpers into `src/be/memory/raters/http-helpers.ts` first.
  - **`MEMORY_RATER_MODEL` override**: should honor as a global override for any kind's default. Document in `runbooks/memory-system.md` during Phase 5.
  - **OpenRouter `response_format: json_schema` quality**: claude's existing `runMemoryRater` uses `response_format` with the JSON schema; the new path uses pi-ai's tool-call mechanism. Quality could differ. Phase 4 manual verification compares side-by-side; if degraded, fall back to "Bypass pi-ai for OpenRouter, keep response_format" (option 3 from the planning Q on schema output).
  - **Opencode plugin bundling**: `plugin/opencode-plugins/agent-swarm.ts` is bundled separately and imported into the worker container per `Dockerfile.worker:244-252`. The `src/utils/internal-ai` import path needs to resolve at bundle time — may require esbuild config tweak or vendoring. Verify during Phase 2.
  - **`SKIP_SESSION_SUMMARY` re-entrancy**: pi's `Bun.spawn` env-extension at `pi-mono-extension.ts:339` set `SKIP_SESSION_SUMMARY: "1"` to prevent the child `claude` from recursing into another summary. With pi-ai (no subprocess), this guard is no longer needed — but keep the env-check at the top of each harness's caller (current pattern at `pi-mono-extension.ts:663`) so external opt-out still works.
- **References**:
  - Research: `thoughts/taras/research/2026-05-10-summarize-session-provider-gaps.md`
  - CHANGELOG #450 (claude Stop hook → OpenRouter migration)
  - pi-ai surface: `node_modules/@mariozechner/pi-ai/dist/` — `stream.d.ts:5`, `models.d.ts:6`, `env-api-keys.d.ts:16`, `utils/oauth/index.d.ts:53`
  - Codex events: `src/providers/codex-adapter.ts:562-717`, finally at `:829-838`
  - Codex OAuth helper: `src/providers/codex-oauth/storage.ts:88` (`getValidCodexOAuth`)
  - Opencode SDK: `node_modules/@opencode-ai/sdk/dist/gen/sdk.gen.d.ts:170`, types at `types.gen.d.ts:2206-2239`, `1458-1474`
  - Memory: `~/.claude/projects/-Users-taras-Documents-code-agent-swarm/memory/feedback_internal_ai_abstraction.md`

## Review Errata

_Reviewed: 2026-05-10 by Claude (auto-apply mode)_

### Applied

- [x] **C1 — `harness` field contract bug** — `completeStructured`'s error log no longer references undeclared `harness` var; uses `opts.callerTag`. `summarizeSession` now derives `callerTag: "session-summary:<harness>"` instead of passing `harness` directly. Lower layer stays harness-agnostic.
- [x] **C2 — `resolveCredential` dual-use violation** — opencode `auth.json` reading moved out of `resolveCredential` into a new `plugin/opencode-plugins/opencode-auth.ts` (lives next to the plugin so it's bundled together). Plugin calls `resolveOpencodeAuth()` first, then injects the result via a new `_credentialOverride` option on `completeStructured`. Phase 0's "no harness check" invariant preserved.
- [x] **C3 — `getOAuthApiKey.newCredentials` token loss** — both codex-OAuth path (Phase 0 step 1) and opencode-OAuth path (Phase 2 step 4) now persist refreshed credentials back to their respective storage before returning. New helper `persistCodexOAuth` added; opencode-auth.ts rewrites `auth.json` on refresh.
- [x] **C4 — Unresolved pi-ai discriminators** — verified against `node_modules/@mariozechner/pi-ai/dist/types.d.ts:117-123`. Locked in: `type: "toolCall"` (camelCase) + `arguments: Record<string, any>` payload field. Plan no longer defers these to impl time.
- [x] **I5 — typebox derail note** — corrected: package is `typebox` (not `@sinclair/typebox`); pi-ai pins `"typebox": "^1.1.24"`. Both derail-note locations updated.
- [x] **I6 — Plugin import path hard gate** — promoted from derail note to Phase 2 success criteria. Documents two fallback paths (vendor helpers OR esbuild alias) if resolution fails.
- [x] **I7 — `kind=<provider>` log line spec** — Phase 0 now requires an always-on `console.log("internal-ai: kind=...")` per call, since Phase 4 QA + Manual E2E Scenario 5 grep for it.
- [x] **I8 — `fetchTaskDetails` citations** — added inline comments at Phase 1 (`pi-mono-extension.ts:70`) and Phase 2 (`agent-swarm.ts:87`) call sites.
- [x] **M9 — Frontmatter status** — `in_progress` → `draft` (no implementation has started).
- [x] **M10 — Phase 0 commit scope** — message now mentions `BASE_SUMMARIZE_PROMPT` extraction.

### Remaining

_None — all findings auto-applied per user authorization._

---

_Re-reviewed: 2026-05-10 by Taras via file-review (3 comments) + Claude (processed)_

### Applied (v4 — file-review pass)

- [x] **Comment #3 (line 968) — `LlmRater` mis-read corrected**. Prior research claimed `LlmRater` was "filtered out at `registry.ts:43`; reachable in tests only". Actually `registry.ts:36-41` explicitly documents that `SERVER_RATERS` is the **server-side** subset only — `LlmRater` runs **worker-side** via the `llm: () => new LlmRater()` factory and produces 461 events / 132 memories rated per 24h in Taras's prod (per the memory-rater daily digest). Phase 5 rewritten: `LlmRater` and its factory stay alive; only `ClaudeCliLlmRaterClient`, `runMemoryRater`, and `MEMORY_LLM_RATER_PROVIDER` are deleted. Migration of `LlmRater` onto `completeStructured` (currently hardcoded to OpenRouter) is spun out to a **separate Linear issue** in the Swarm Bugs and Features project.
- [x] **Comment #2 (line 155) — default OpenAI models renamed** from `gpt-5-mini` → `gpt-5.4-mini` in both `"openai"` and `"openai-codex"` `DEFAULT_MODEL` entries.
- [x] **Comment #1 (line 22) — pre-plan spike** written at `scripts/spike-internal-ai.ts` and run against `.env.*` creds. All three providers (openrouter/gemini-3-flash-preview, openai/gpt-5.4-mini, anthropic/claude-haiku-4-5) returned `type: "toolCall"` + `arguments` payload + `stopReason: "toolUse"`; zod validation passed for all three. Findings folded into Current State Analysis "Spike findings" table.
- [x] **LlmRater follow-up issue created** — [DES-363](https://linear.app/desplega-labs/issue/DES-363/migrate-llmrater-to-completestructured-break-openrouter-hardcode). Needs to be moved from Backlog into the Swarm Bugs and Features project (no `--project` flag on `linear create-issue` CLI).
