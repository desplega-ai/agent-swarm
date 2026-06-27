/**
 * Generic "additive ingress" helper for Phase 2 cross-ingress sibling-awareness.
 *
 * Wraps `createAdditiveBuffer` with the typical pattern used by comment-style
 * ingress points (AgentMail threads, GitHub/GitLab issue comments, Linear
 * comments): when a sibling task is already in flight for the same contextKey,
 * debounce rapid follow-up inputs into a SINGLE follow-up task instead of
 * spawning N tasks.
 *
 * This generalizes the Slack `ADDITIVE_SLACK` buffer — Slack's own buffer stays
 * as-is to preserve exact behaviour; other ingress points opt in via env flags.
 *
 * Default: opt-in (env flag unset => all calls are no-ops; caller proceeds to
 * create a task normally).
 */

import { type AdditiveBuffer, createAdditiveBuffer } from "./additive-buffer";

export type IngressFlushReason = "timer" | "manual";

export interface IngressBufferItem<T> {
  payload: T;
  enqueuedAt: number;
}

export interface IngressBufferOptions<T> {
  /** Short identifier used in logs, e.g. "agentmail", "github-issue-comment". */
  source: string;
  /**
   * Env flag name (e.g. `"ADDITIVE_AGENTMAIL"`). When the flag resolves to
   * `"true"` the buffer is enabled; otherwise `maybeBuffer()` is a no-op.
   */
  envFlag: string;
  /** Debounce timeout in ms. Reset on every enqueue. Default: 10000ms. */
  timeoutMs?: number;
  /**
   * Called when the buffer flushes (timer expiry OR manual). Receives the
   * payloads in arrival order, the contextKey, and the reason. Errors thrown
   * here are logged and swallowed.
   */
  onFlush: (items: T[], contextKey: string, reason: IngressFlushReason) => Promise<void> | void;
}

export interface IngressBuffer<T> {
  /**
   * `true` when the env flag was set to `"true"` at construction time.
   * Callers should still guard with `maybeBuffer` — this is informational.
   */
  enabled: boolean;
  /**
   * Attempt to buffer an input. Returns `true` when the item was buffered
   * (caller MUST NOT create a task), `false` otherwise (caller proceeds).
   *
   * Params:
   *   - `contextKey`  — uniform sibling key from Phase 1. Empty string disables.
   *   - `siblingInFlight` — whether the caller already knows a sibling exists
   *     for `contextKey`. Callers typically pass the boolean from
   *     `getInProgressTasksByContextKey(contextKey).length > 0`.
   *   - `payload` — the item to buffer.
   */
  maybeBuffer(contextKey: string, siblingInFlight: boolean, payload: T): boolean;
  /** True if the key currently has a pending buffer (for debugging/tests). */
  isBuffered(contextKey: string): boolean;
  /** Count of items in the buffer for `contextKey`. */
  count(contextKey: string): number;
  /** Flush immediately, cancelling the debounce timer. */
  instantFlush(contextKey: string): Promise<void>;
  /** Drop buffered items without flushing. */
  cancel(contextKey: string): void;
  /** Raw underlying buffer — escape hatch for tests. */
  _buffer: AdditiveBuffer<T>;
}

/**
 * Read the env flag value lazily so tests can toggle it without re-importing.
 */
function envEnabled(flag: string): boolean {
  return process.env[flag] === "true";
}

/**
 * Create an ingress buffer. The wrapper records the env flag at construction
 * time (not per-call) so behaviour is stable across a process run.
 *
 * Consumers typically:
 *   1. Look up siblings for the contextKey (`getInProgressTasksByContextKey`).
 *   2. Call `buffer.maybeBuffer(contextKey, siblings.length > 0, payload)`.
 *   3. If `true`, stop — buffered. Otherwise, proceed to `createTaskWithSiblingAwareness`.
 */
export function createIngressBuffer<T>(opts: IngressBufferOptions<T>): IngressBuffer<T> {
  const enabled = envEnabled(opts.envFlag);
  const timeoutMs = opts.timeoutMs ?? 10_000;

  const buffer = createAdditiveBuffer<T>({
    timeoutMs,
    label: opts.source,
    onFlush: async (items, key, reason) => {
      await opts.onFlush(items, key, reason);
    },
  });

  return {
    enabled,
    maybeBuffer(contextKey, siblingInFlight, payload) {
      if (!enabled) return false;
      if (!contextKey) return false;
      if (!siblingInFlight) return false;
      buffer.enqueue(contextKey, payload);
      return true;
    },
    isBuffered(contextKey) {
      return buffer.isBuffered(contextKey);
    },
    count(contextKey) {
      return buffer.count(contextKey);
    },
    instantFlush(contextKey) {
      return buffer.instantFlush(contextKey);
    },
    cancel(contextKey) {
      buffer.cancel(contextKey);
    },
    _buffer: buffer,
  };
}
