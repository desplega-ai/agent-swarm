/**
 * Adapter-side swarm lifecycle hooks for the Codex provider.
 *
 * Phase 5 of the codex provider rollout. Mirrors `pi-mono-extension.ts`
 * but adapted to the event-stream model: instead of pi-mono's
 * `pi.on("tool_call", ...)` extension API, we attach a single listener to
 * `CodexSession.onEvent(...)` and react to normalized `ProviderEvent`s.
 *
 * ## Two-layer cancellation
 *
 * Layer 1 — runner-side polling: `src/commands/runner.ts:2812-2841` already
 * polls `GET /cancelled-tasks?taskId=...` on a timer and calls
 * `session.abort()` for any `ProviderSession`. Codex inherits this for free.
 *
 * Layer 2 — adapter-side (this file): on every `tool_start` we (throttled)
 * check the same endpoint and abort the running turn via the shared
 * `AbortController`. This *accelerates* cancellation latency but does NOT
 * block tool execution — Codex's SDK lacks a preToolUse blocking hook
 * (unlike pi-mono's `block: true` return value).
 *
 * The handler MUST be synchronous from the caller's perspective. Every
 * fetch is fire-and-forget with `.catch(() => {})` so a single bad request
 * never breaks the session. The handler also never throws — `try/catch`
 * around the dispatch swallows everything for safety.
 */

import { checkToolLoop } from "../hooks/tool-loop-detection";
import type { ProviderEvent } from "./types";

export interface CodexSwarmEventHandlerOpts {
  apiUrl: string;
  apiKey: string;
  agentId: string;
  /** Task currently being worked on. When null, all task-scoped hooks are no-ops. */
  taskId: string | null;
  /** Mutable reference to the session's per-turn AbortController. */
  abortRef: { current: AbortController | null };
}

/** Throttle windows (ms) keyed by action name. */
const CANCELLATION_THROTTLE_MS = 500;
const HEARTBEAT_THROTTLE_MS = 5_000;
const ACTIVITY_THROTTLE_MS = 5_000;
const CONTEXT_THROTTLE_MS = 30_000;

function apiHeaders(opts: CodexSwarmEventHandlerOpts): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${opts.apiKey}`,
    "X-Agent-ID": opts.agentId,
  };
}

function fireAndForget(url: string, init: RequestInit): void {
  void fetch(url, init).catch(() => {});
}

/** Build the handler. The returned function reacts to normalized events. */
export function createCodexSwarmEventHandler(
  opts: CodexSwarmEventHandlerOpts,
): (event: ProviderEvent) => void {
  const lastCall: Record<string, number> = {};
  let sessionId: string | undefined;

  const shouldRun = (key: string, throttleMs: number): boolean => {
    const now = Date.now();
    if (now - (lastCall[key] ?? 0) < throttleMs) return false;
    lastCall[key] = now;
    return true;
  };

  const checkCancelled = (): void => {
    const taskId = opts.taskId;
    if (!taskId) return;
    void (async () => {
      try {
        const res = await fetch(
          `${opts.apiUrl}/cancelled-tasks?taskId=${encodeURIComponent(taskId)}`,
          { headers: apiHeaders(opts) },
        );
        if (!res.ok) return;
        const data = (await res.json()) as {
          cancelled?: Array<{ id: string; failureReason?: string }>;
        };
        const isCancelled = data.cancelled?.some((t) => t.id === taskId);
        if (isCancelled) {
          opts.abortRef.current?.abort();
        }
      } catch {
        // Swallow — fire-and-forget.
      }
    })();
  };

  const checkLoop = (toolName: string, args: unknown): void => {
    const taskId = opts.taskId;
    if (!taskId) return;
    const argRecord = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
    void checkToolLoop(taskId, toolName, argRecord)
      .then((result) => {
        if (result.blocked) {
          opts.abortRef.current?.abort();
        }
      })
      .catch(() => {});
  };

  return (event: ProviderEvent): void => {
    try {
      switch (event.type) {
        case "session_init": {
          sessionId = event.sessionId;
          break;
        }
        case "tool_start": {
          if (shouldRun("cancellation", CANCELLATION_THROTTLE_MS)) {
            checkCancelled();
          }
          checkLoop(event.toolName, event.args);
          if (opts.taskId && shouldRun("heartbeat", HEARTBEAT_THROTTLE_MS)) {
            fireAndForget(
              `${opts.apiUrl}/api/active-sessions/heartbeat/${encodeURIComponent(opts.taskId)}`,
              { method: "PUT", headers: apiHeaders(opts) },
            );
          }
          if (shouldRun("activity", ACTIVITY_THROTTLE_MS)) {
            fireAndForget(
              `${opts.apiUrl}/api/agents/${encodeURIComponent(opts.agentId)}/activity`,
              { method: "PUT", headers: apiHeaders(opts) },
            );
          }
          break;
        }
        case "context_usage": {
          if (opts.taskId && shouldRun("context-progress", CONTEXT_THROTTLE_MS)) {
            fireAndForget(`${opts.apiUrl}/api/tasks/${encodeURIComponent(opts.taskId)}/context`, {
              method: "POST",
              headers: apiHeaders(opts),
              body: JSON.stringify({
                eventType: "progress",
                sessionId: sessionId ?? `codex-${opts.taskId}`,
                contextUsedTokens: event.contextUsedTokens,
                contextTotalTokens: event.contextTotalTokens,
                contextPercent: event.contextPercent,
              }),
            });
          }
          break;
        }
        case "compaction": {
          if (opts.taskId) {
            fireAndForget(`${opts.apiUrl}/api/tasks/${encodeURIComponent(opts.taskId)}/context`, {
              method: "POST",
              headers: apiHeaders(opts),
              body: JSON.stringify({
                eventType: "compaction",
                sessionId: sessionId ?? `codex-${opts.taskId}`,
                contextTotalTokens: event.contextTotalTokens,
                preCompactTokens: event.preCompactTokens,
                compactTrigger: event.compactTrigger,
              }),
            });
          }
          break;
        }
        case "result": {
          // Final completion context event mirrors pi-mono's session_shutdown
          // POST. The runner separately calls `/api/tasks/{id}/finish`.
          if (opts.taskId) {
            fireAndForget(`${opts.apiUrl}/api/tasks/${encodeURIComponent(opts.taskId)}/context`, {
              method: "POST",
              headers: apiHeaders(opts),
              body: JSON.stringify({
                eventType: "completion",
                sessionId: sessionId ?? `codex-${opts.taskId}`,
              }),
            });
          }
          break;
        }
      }
    } catch {
      // Never throw from the handler — the event loop is hot.
    }
  };
}
