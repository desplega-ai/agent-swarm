---
date: 2026-03-28T00:00:00+01:00
researcher: Claude
git_commit: 34f6e21
branch: main
repository: agent-swarm
topic: "Surfacing Claude CLI subscription, rate limit, and account data"
tags: [research, claude-cli, rate-limits, subscription, stream-json, provider-events]
status: complete
autonomy: critical
last_updated: 2026-03-28
last_updated_by: Claude
---

# Research: Surfacing Claude CLI Subscription, Rate Limit, and Account Data

**Date**: 2026-03-28
**Researcher**: Claude
**Git Commit**: 34f6e21
**Branch**: main

## Research Question

How can we surface subscription information (rate limits, usage, etc.) and account information (email, plan tier) from the Claude CLI streaming output into the agent-swarm system?

## Summary

The Claude CLI emits a `rate_limit_event` on every API request when running with `--output-format stream-json`. This event contains subscription-level rate limit data (status, reset time, limit type, overage status). Agent-swarm currently ignores this event — it falls through to the `default` case in `prettyPrintLine()` and is logged as an unhandled type. The full `SDKMessage` union type from the Agent SDK defines 21 event types, of which agent-swarm's `processJsonLine()` only handles 4 (plus error tracking).

**For account/identity data (email, plan tier): the Claude CLI does not emit this in any streaming event.** The `system/init` event provides `apiKeySource` (e.g., `"ANTHROPIC_API_KEY"`, `"claude_ai"`) and `model`, but no account email, plan name, or billing details. There are open GitHub issues requesting this ([#1886](https://github.com/anthropics/claude-code/issues/1886), [#19906](https://github.com/anthropics/claude-code/issues/19906)) but nothing shipped yet. The `claude auth status` CLI command shows subscription type interactively, but has no JSON output mode.

## Detailed Findings

### 1. The `SDKRateLimitEvent` Type

The Claude CLI emits this on every API request. The authoritative TypeScript type is defined in `@anthropic-ai/claude-agent-sdk`:

```typescript
interface SDKRateLimitEvent {
  type: "rate_limit_event";
  rate_limit_info: {
    status: "allowed" | "allowed_warning" | "rejected";
    resetsAt?: number;                    // Unix timestamp (seconds)
    rateLimitType?: string;               // e.g. "five_hour"
    overageStatus?: string;               // e.g. "rejected"
    overageDisabledReason?: string;       // e.g. "org_level_disabled"
    isUsingOverage?: boolean;
    utilization?: number;                 // 0.0–1.0 (how close to the limit)
  };
  uuid: string;
  session_id: string;
}
```

**Real example from local session logs:**

```json
{
  "type": "rate_limit_event",
  "rate_limit_info": {
    "status": "allowed",
    "resetsAt": 1774130400,
    "rateLimitType": "five_hour",
    "overageStatus": "rejected",
    "overageDisabledReason": "org_level_disabled",
    "isUsingOverage": false
  },
  "uuid": "ebc606aa-b8a4-4b6c-b5f8-2a9ea50be5cf",
  "session_id": "174cfd3a-bccd-45cb-b32c-481c00b172a2"
}
```

**Status values:**
- `"allowed"` — request passed, within limits (observed locally)
- `"allowed_warning"` — approaching the limit (from SDK types, not observed locally)
- `"rejected"` — rate limited, CLI retries internally (from SDK types, not observed locally)

**Mapping from Anthropic API headers:** The CLI internally parses `anthropic-ratelimit-unified-*` headers and wraps them into this event. Key headers include `anthropic-ratelimit-unified-status`, `anthropic-ratelimit-unified-5h-utilization`, `anthropic-ratelimit-unified-5h-reset`, `anthropic-ratelimit-unified-representative-claim`.

### 2. The `system/init` Event

First event emitted per session. Contains session configuration but no account-level data:

```json
{
  "type": "system",
  "subtype": "init",
  "session_id": "b8529f7b-...",
  "cwd": "/Users/taras/Documents/code/agent-swarm",
  "model": "claude-opus-4-6",
  "permissionMode": "bypassPermissions",
  "apiKeySource": "ANTHROPIC_API_KEY",
  "claude_code_version": "2.1.75",
  "tools": ["Task", "Bash", "Read", "...159 more"],
  "mcp_servers": [{"name": "agent-swarm-local", "status": "connected"}, ...],
  "agents": ["general-purpose", "Explore", "...49 more"],
  "skills": ["debug", "simplify", "...72 more"],
  "plugins": [{"name": "agent-sdk-dev", "path": "..."}, "...21 more"],
  "slash_commands": ["debug", "simplify", "...146 more"],
  "output_style": "default",
  "fast_mode_state": "off"
}
```

**Actionable:** We could expand `processJsonLine()` to also extract from the init event: (1) `cwd`, (2) `claude_code_version` (harness version), (3) `apiKeySource` (last 5 chars for identification without leaking full key). These would be useful metadata to store per-session on the agent/task record.

**`apiKeySource`** is the closest thing to account info. Known values: `"ANTHROPIC_API_KEY"` (env var), `"claude_ai"` (Pro/Max subscription). No email, no plan tier, no org name.

### 3. The `system/api_error` Event

Emitted when an API request fails with a retryable error. Contains retry metadata:

```json
{
  "type": "system",
  "subtype": "api_error",
  "level": "error",
  "error": {
    "status": 529,
    "requestID": "req_011CZTJBDfucS2orkaAiZ1Gv",
    "error": {
      "type": "overloaded_error",
      "message": "Overloaded. https://docs.claude.com/en/api/errors"
    }
  },
  "retryInMs": 616.43,
  "retryAttempt": 1,
  "maxRetries": 10
}
```

Agent-swarm does NOT handle this event type. It falls through to `default` in `prettyPrintLine()` and is not tracked by `trackErrorFromJson()` (which only checks `type === "error"`, not `type === "system" && subtype === "api_error"`).

### 4. The `result` Event — Cost/Usage Data

Always the last event. Already partially captured by agent-swarm:

```json
{
  "type": "result",
  "subtype": "success",
  "total_cost_usd": 0.7565345,
  "duration_ms": 100135,
  "duration_api_ms": 94900,
  "num_turns": 17,
  "usage": {
    "input_tokens": 32,
    "cache_creation_input_tokens": 52360,
    "cache_read_input_tokens": 662549,
    "output_tokens": 3914,
    "service_tier": "standard"
  },
  "modelUsage": {
    "claude-opus-4-6": {
      "inputTokens": 32,
      "outputTokens": 3914,
      "costUSD": 0.7565345,
      "contextWindow": 200000,
      "maxOutputTokens": 32000
    }
  }
}
```

`service_tier` is always `"standard"` in local data. `inference_geo` is always `"not_available"`.

### 5. Complete SDKMessage Union Type (21 Event Types)

From `@anthropic-ai/claude-agent-sdk`:

| Type | Subtype | Currently handled by agent-swarm? |
|------|---------|----------------------------------|
| `system` | `init` | Partially — only `session_id` and `model` extracted (`claude-adapter.ts:369-375`) |
| `system` | `compact_boundary` | Yes (`claude-adapter.ts:378-385`) |
| `system` | `status` | No — falls to default |
| `system` | `api_error` | No — falls to default (and missed by error tracker) |
| `system` | `hook_started` | No — falls to default |
| `system` | `hook_progress` | No — falls to default |
| `system` | `hook_response` | No — pretty-printed but not structurally captured |
| `system` | `local_command_output` | No — falls to default |
| `system` | `task_notification` | No — falls to default |
| `system` | `files_persisted` | No — falls to default |
| `assistant` | — | Partially — tool_use and usage extracted, text/thinking ignored |
| `user` | — | No — pretty-printed only |
| `result` | `success`/`error_*` | Partially — cost data extracted, subtype/result text not captured in ProviderEvent |
| `stream_event` | — | No — requires `--include-partial-messages` flag |
| `rate_limit_event` | — | **No — falls to default** |
| `auth_status` | — | No |
| `tool_progress` | — | No |
| `tool_use_summary` | — | No |
| `prompt_suggestion` | — | No |
| `pr-link` | — | No (CLI-internal, not relevant to worker sessions) |
| `progress` | — | No (CLI-internal) |

### 6. Current Event Processing Pipeline

```
Claude CLI stdout (stream-json)
  │
  ├─→ emit({ type: "raw_log", content: line })     ← EVERY line, unconditionally
  │
  └─→ processJsonLine(line)                         ← Structured parsing
       │
       ├─ system/init        → emit(session_init)   ← Only session_id + model
       ├─ system/compact     → emit(compaction)
       ├─ result             → emit(result + CostData)
       ├─ assistant          → emit(tool_start) + emit(context_usage)
       ├─ [everything else]  → IGNORED (no event emitted)
       │
       └─ trackErrorFromJson(json)                   ← Error tracking on ALL parsed JSON
            ├─ assistant + message.error → addApiError(category)
            ├─ type === "error"          → addErrorEvent()
            └─ result + is_error         → addResultError()

Runner event listener:
  session_init   → saves to API, buffers session.start event
  tool_start     → updates task progress (throttled 3s)
  result         → buffers session.end event with cost
  context_usage  → POSTs to /api/tasks/{id}/context (throttled 30s)
  compaction     → POSTs to /api/tasks/{id}/context
  raw_log        → prettyPrintLine() + streams to API log buffer
  raw_stderr     → prettyPrintStderr()
```

### 7. What Is NOT Available from the CLI

- **Account email** — not in any event type. Requested: [Issue #1886](https://github.com/anthropics/claude-code/issues/1886), [Issue #19906](https://github.com/anthropics/claude-code/issues/19906)
- **Plan tier/name** (Pro, Max, Teams, Enterprise) — not emitted. `apiKeySource` gives auth method only
- **Billing status** — not emitted
- **Organization name/ID** — not emitted (though `anthropic-organization-id` appears in API error response headers)
- **Token budget/remaining** — not emitted (only per-request usage in result events)
- **Rate limit headers** — the CLI wraps these into `rate_limit_event` but drops the granular per-window headers. Only the "representative claim" window is surfaced
- **Rate limit data in statusline/hooks** — not currently exposed. Requested: [Issue #33820](https://github.com/anthropics/claude-code/issues/33820), [Issue #29300](https://github.com/anthropics/claude-code/issues/29300), [Issue #36056](https://github.com/anthropics/claude-code/issues/36056)

## Code References

| File | Line | Description |
|------|------|-------------|
| `src/providers/claude-adapter.ts` | 224-254 | CLI spawn with `--output-format stream-json` |
| `src/providers/claude-adapter.ts` | 266-306 | Stdout streaming, line splitting, raw_log emission |
| `src/providers/claude-adapter.ts` | 364-466 | `processJsonLine()` — 4 branches for system/init, system/compact, result, assistant |
| `src/providers/claude-adapter.ts` | 462 | `trackErrorFromJson()` call on every parsed JSON |
| `src/providers/types.ts` | 18-40 | `ProviderEvent` union type definition |
| `src/providers/types.ts` | 75 | `ProviderResult` interface (has `output` field that Claude adapter never sets) |
| `src/utils/pretty-print.ts` | 73-235 | `prettyPrintLine()` — handles system/assistant/user/result/error, everything else to default |
| `src/utils/pretty-print.ts` | 226-229 | `default` case — where rate_limit_event ends up |
| `src/utils/error-tracker.ts` | 136-190 | `trackErrorFromJson()` — detects rate_limit/auth/billing errors |
| `src/utils/error-tracker.ts` | 171-190 | `parseStderrForErrors()` — pattern matching on stderr |
| `src/commands/runner.ts` | 1635-1800 | Runner event listener — consumes ProviderEvents, forwards to API |
| `src/commands/runner.ts` | 1776-1794 | `raw_log` handling — prettyPrint + log buffer streaming |

## Architecture Documentation

The event processing has a clear layered architecture:

1. **Transport layer** (`claude-adapter.ts:processStreams`) — raw byte stream → line-delimited strings. Every line becomes a `raw_log` ProviderEvent regardless of content.
2. **Parsing layer** (`claude-adapter.ts:processJsonLine`) — selective extraction of 4 known event types into typed ProviderEvents. Everything else is silently passed through.
3. **Error layer** (`error-tracker.ts:trackErrorFromJson`) — cross-cutting concern that scans all parsed JSON for error signals.
4. **Rendering layer** (`pretty-print.ts:prettyPrintLine`) — handles 5 types with formatting, everything else gets a generic `[type] {json}` dump.
5. **Forwarding layer** (`runner.ts:session.onEvent`) — forwards structured ProviderEvents to the API server, streams raw_log content to the log buffer.

The key gap: layers 2-5 were designed around the original 4-5 event types and have not been updated as the CLI added new event types (rate_limit_event, api_error, auth_status, etc.).

## Historical Context (from thoughts/)

No prior research on this specific topic was found in `thoughts/`.

## Related Research

- `thoughts/taras/research/2026-03-18-agent-fs-integration.md` — mentions rate limiting in agent-fs context (configurable per-server, 60 RPM default), separate from Claude CLI rate limits

## External References

- [Issue #24596 — CLI stream-json lacks event type reference](https://github.com/anthropics/claude-code/issues/24596) — recognized documentation gap
- [Issue #26498 — Python SDK MessageParseError on rate_limit_event](https://github.com/anthropics/claude-code/issues/26498) — event type added to CLI before SDKs updated
- [Issue #33820 — Expose rate-limit headers to hooks](https://github.com/anthropics/claude-code/issues/33820)
- [Issue #29300 — Expose rate limit in statusline JSON](https://github.com/anthropics/claude-code/issues/29300)
- [Issue #36056 — Expose rate limit in statusLine JSON](https://github.com/anthropics/claude-code/issues/36056)
- [Issue #1886 — Make /status checkable from CLI](https://github.com/anthropics/claude-code/issues/1886) — no `claude whoami` command
- [Issue #19906 — Show account in /usage](https://github.com/anthropics/claude-code/issues/19906)
- [Agent SDK TypeScript — SDKMessage types](https://github.com/anthropics/claude-agent-sdk-typescript)
- [Agent SDK Python — types.py](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/types.py)
- [Anthropic API Rate Limits](https://docs.anthropic.com/en/api/rate-limits) — standard and unified headers

## Open Questions

- The `utilization` field (0.0–1.0) represents how close the account is to hitting its rate limit (0.0 = no usage, 1.0 = at the limit). It is defined in the SDK type but was never observed in local session data. It may only be emitted when approaching limits or for certain plan types. Worth monitoring once we start capturing `rate_limit_event` structured data.
- The `system/api_error` event contains `anthropic-organization-id` in the response headers. This could potentially be used as a stable org identifier — worth exploring.
- `rate_limit_event` may not be emitted for all auth types (API keys vs. Pro/Max subscription). The `rateLimitType: "five_hour"` suggests subscription-specific windows. Implementation should be fail-safe: no-op if the event or fields don’t exist.
