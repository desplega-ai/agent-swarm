/**
 * Shared adapter-side swarm-event handler factory.
 *
 * Phase 5 extraction (see thoughts/.../2026-04-28-claude-managed-agents-provider.md
 * § Phase 5). Originally lived inline in `codex-swarm-events.ts`; lifted out
 * here so the `claude-managed` adapter (and any future adapter that wants the
 * same throttle/poll/heartbeat scaffolding) can reuse it.
 *
 * ## What this owns
 *
 * - `apiHeaders`, `fireAndForget`
 * - Throttle constants and the `shouldRun` gate
 * - `checkCancelled`, `checkLoop`, `heartbeat`, `activity`
 * - `progressContextUsage`, `progressCompaction`, `progressCompletion`
 *
 * ## What this does NOT own
 *
 * Provider-specific dispatch lives in each adapter's `*-swarm-events.ts`. For
 * example codex's per-turn cost-data shape, or claude-managed's interrupt+
 * archive cancel callback. The shared file exposes the throttled primitives
 * and a generic event-dispatch shell; the per-provider wrapper supplies any
 * `onCancel` / extension points it needs.
 *
 * ## Two-layer cancellation (unchanged from codex)
 *
 * Layer 1 — runner-side polling: `src/commands/runner.ts` polls
 * `GET /cancelled-tasks` on a timer and calls `session.abort()`. All providers
 * inherit this for free.
 *
 * Layer 2 — adapter-side (this file): on every `tool_start` we (throttled)
 * check the same endpoint and abort the running turn via the shared
 * `AbortController`. This *accelerates* cancellation latency.
 *
 * ## Hard contract
 *
 * - The handler is synchronous from the caller's perspective.
 * - Every fetch is fire-and-forget with `.catch(() => {})` so a single bad
 *   request never breaks the session.
 * - The handler never throws — `try/catch` around the dispatch swallows
 *   everything for safety.
 */

import { checkToolLoop } from "../hooks/tool-loop-detection";
import type { ProviderEvent } from "./types";

/** Throttle windows (ms) keyed by action name. Exported for unit assertions. */
export const CANCELLATION_THROTTLE_MS = 500;
export const HEARTBEAT_THROTTLE_MS = 5_000;
export const ACTIVITY_THROTTLE_MS = 5_000;
export const CONTEXT_THROTTLE_MS = 30_000;

export interface SwarmEventHandlerOpts {
  apiUrl: string;
  apiKey: string;
  agentId: string;
  /** Task currently being worked on. When null, all task-scoped hooks are no-ops. */
  taskId: string | null;
  /** Mutable reference to the session's per-turn AbortController. */
  abortRef: { current: AbortController | null };
  /**
   * Optional callback invoked when a cancellation is detected (in addition to
   * the abort-controller fire). Adapters that need provider-specific cancel
   * actions (e.g. claude-managed sending `user.interrupt` + archiving) wire
   * it here. Errors are swallowed.
   */
  onCancel?: () => void | Promise<void>;
  /**
   * Prefix used in the synthetic `sessionId` body field on context POSTs when
   * `session_init` hasn't fired yet. Codex preserves its historical
   * `codex-${taskId}` shape; new providers can pick their own.
   */
  sessionIdFallbackPrefix?: string;
}

export function apiHeaders(opts: SwarmEventHandlerOpts): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${opts.apiKey}`,
    "X-Agent-ID": opts.agentId,
  };
}

export function fireAndForget(url: string, init: RequestInit): void {
  void fetch(url, init).catch(() => {});
}

/**
 * Build the handler. The returned function reacts to normalized events.
 *
 * Mirrors the codex-swarm-events behavior exactly — providers that want
 * additional event-type handling can compose this with their own dispatch
 * (e.g. by wrapping the returned handler).
 */
export function createSwarmEventHandler(
  opts: SwarmEventHandlerOpts,
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
          if (opts.onCancel) {
            try {
              await opts.onCancel();
            } catch {
              // Swallow — best-effort.
            }
          }
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

  const heartbeat = (): void => {
    if (opts.taskId && shouldRun("heartbeat", HEARTBEAT_THROTTLE_MS)) {
      fireAndForget(
        `${opts.apiUrl}/api/active-sessions/heartbeat/${encodeURIComponent(opts.taskId)}`,
        { method: "PUT", headers: apiHeaders(opts) },
      );
    }
  };

  const activity = (): void => {
    if (shouldRun("activity", ACTIVITY_THROTTLE_MS)) {
      fireAndForget(`${opts.apiUrl}/api/agents/${encodeURIComponent(opts.agentId)}/activity`, {
        method: "PUT",
        headers: apiHeaders(opts),
      });
    }
  };

  const progressContextUsage = (event: {
    contextUsedTokens: number;
    contextTotalTokens: number;
    contextPercent: number;
  }): void => {
    if (opts.taskId && shouldRun("context-progress", CONTEXT_THROTTLE_MS)) {
      fireAndForget(`${opts.apiUrl}/api/tasks/${encodeURIComponent(opts.taskId)}/context`, {
        method: "POST",
        headers: apiHeaders(opts),
        body: JSON.stringify({
          eventType: "progress",
          sessionId: sessionId ?? `${opts.sessionIdFallbackPrefix ?? "session"}-${opts.taskId}`,
          contextUsedTokens: event.contextUsedTokens,
          contextTotalTokens: event.contextTotalTokens,
          contextPercent: event.contextPercent,
        }),
      });
    }
  };

  const progressCompaction = (event: {
    contextTotalTokens: number;
    preCompactTokens?: number;
    compactTrigger?: string;
  }): void => {
    if (opts.taskId) {
      fireAndForget(`${opts.apiUrl}/api/tasks/${encodeURIComponent(opts.taskId)}/context`, {
        method: "POST",
        headers: apiHeaders(opts),
        body: JSON.stringify({
          eventType: "compaction",
          sessionId: sessionId ?? `${opts.sessionIdFallbackPrefix ?? "session"}-${opts.taskId}`,
          contextTotalTokens: event.contextTotalTokens,
          preCompactTokens: event.preCompactTokens,
          compactTrigger: event.compactTrigger,
        }),
      });
    }
  };

  const progressCompletion = (): void => {
    if (opts.taskId) {
      fireAndForget(`${opts.apiUrl}/api/tasks/${encodeURIComponent(opts.taskId)}/context`, {
        method: "POST",
        headers: apiHeaders(opts),
        body: JSON.stringify({
          eventType: "completion",
          sessionId: sessionId ?? `${opts.sessionIdFallbackPrefix ?? "session"}-${opts.taskId}`,
        }),
      });
    }
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
          heartbeat();
          activity();
          break;
        }
        case "context_usage": {
          progressContextUsage({
            contextUsedTokens: event.contextUsedTokens,
            contextTotalTokens: event.contextTotalTokens,
            contextPercent: event.contextPercent,
          });
          break;
        }
        case "compaction": {
          progressCompaction({
            contextTotalTokens: event.contextTotalTokens,
            preCompactTokens: event.preCompactTokens,
            compactTrigger: event.compactTrigger,
          });
          break;
        }
        case "result": {
          progressCompletion();
          break;
        }
      }
    } catch {
      // Never throw from the handler — the event loop is hot.
    }
  };
}
