/**
 * Generic additive/debounce buffer, keyed on `contextKey` (or any string key).
 *
 * Phase 2 of cross-ingress sibling-task awareness — research §5.
 *
 * Extracted from `src/slack/thread-buffer.ts` so any ingress (AgentMail,
 * GitHub/GitLab issue comments, Linear comments — NOT schedule/workflow) can
 * coalesce rapid follow-up inputs into a single task.
 *
 * The primitive is a factory: each caller owns its own buffer registry with
 * its own flush callback. That keeps flush semantics ingress-specific while
 * the debounce / append / count plumbing is shared.
 *
 * Behavior:
 *   - `enqueue(key, item)` appends `item` to the in-memory buffer for `key`.
 *   - The debounce timer is reset on every append.
 *   - When the timer fires, `onFlush(items, key, reason="timer")` is called
 *     with the accumulated list.
 *   - `instantFlush(key)` fires the callback immediately with
 *     `reason="manual"` and clears the buffer.
 *   - `cancel(key)` drops the buffer without flushing (used by ingress when
 *     the underlying context becomes irrelevant — e.g. user cancels).
 *
 * Concurrency: single-process, single-event-loop. No cross-instance locking.
 * Flush callbacks run sequentially per key (the buffer is cleared BEFORE the
 * callback fires, so re-enqueues during `onFlush` create a fresh buffer).
 */

export type BufferFlushReason = "timer" | "manual";

export interface AdditiveBufferOptions<T> {
  /**
   * Debounce timeout. Resets on every append. When it elapses without new
   * appends, `onFlush` is called.
   */
  timeoutMs: number;
  /**
   * Called with the accumulated items when the buffer flushes. Receives the
   * `contextKey` the buffer was created under and a `reason` indicating
   * whether this was a timer-driven flush or a manual (`instantFlush`) one.
   *
   * Errors thrown here are caught and logged — they do NOT re-enter the
   * buffer, because the buffer has already been cleared by the time `onFlush`
   * is called. Callers that need retry semantics must implement them inside
   * `onFlush`.
   */
  onFlush: (items: T[], contextKey: string, reason: BufferFlushReason) => void | Promise<void>;
  /**
   * Optional label, used in log lines (`[buffer:${label}]`). Helps when
   * multiple buffers exist in the same process.
   */
  label?: string;
}

export interface AdditiveBuffer<T> {
  /** Append an item, creating the buffer if needed. Resets the debounce timer. */
  enqueue(contextKey: string, item: T): void;
  /** True when a buffer exists for this key (i.e. at least one item is queued). */
  isBuffered(contextKey: string): boolean;
  /** Number of items currently queued for this key, or 0. */
  count(contextKey: string): number;
  /** Flush immediately with `reason="manual"`. No-op when no buffer exists. */
  instantFlush(contextKey: string): Promise<void>;
  /** Drop the buffer without flushing. No-op when no buffer exists. */
  cancel(contextKey: string): boolean;
  /** For tests / diagnostics. */
  keys(): string[];
}

interface BufferEntry<T> {
  items: T[];
  timer: ReturnType<typeof setTimeout>;
}

export function createAdditiveBuffer<T>(options: AdditiveBufferOptions<T>): AdditiveBuffer<T> {
  const { timeoutMs, onFlush, label } = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`additive-buffer: timeoutMs must be a positive number, got ${timeoutMs}`);
  }

  const buffers = new Map<string, BufferEntry<T>>();
  const prefix = label ? `[buffer:${label}]` : "[buffer]";

  function scheduleFlush(key: string) {
    return setTimeout(() => {
      void doFlush(key, "timer");
    }, timeoutMs);
  }

  async function doFlush(key: string, reason: BufferFlushReason): Promise<void> {
    const entry = buffers.get(key);
    if (!entry || entry.items.length === 0) {
      buffers.delete(key);
      return;
    }
    clearTimeout(entry.timer);
    buffers.delete(key);
    try {
      await onFlush(entry.items, key, reason);
    } catch (error) {
      console.error(`${prefix} onFlush threw for key=${key}:`, error);
    }
  }

  return {
    enqueue(contextKey: string, item: T): void {
      if (!contextKey) {
        throw new Error("additive-buffer: contextKey is required");
      }
      const existing = buffers.get(contextKey);
      if (existing) {
        clearTimeout(existing.timer);
        existing.items.push(item);
        existing.timer = scheduleFlush(contextKey);
        console.log(
          `${prefix} append: ${contextKey} (${existing.items.length} items, timer reset to ${timeoutMs}ms)`,
        );
      } else {
        const entry: BufferEntry<T> = {
          items: [item],
          timer: scheduleFlush(contextKey),
        };
        buffers.set(contextKey, entry);
        console.log(`${prefix} created: ${contextKey} (timer set to ${timeoutMs}ms)`);
      }
    },

    isBuffered(contextKey: string): boolean {
      return buffers.has(contextKey);
    },

    count(contextKey: string): number {
      return buffers.get(contextKey)?.items.length ?? 0;
    },

    instantFlush(contextKey: string): Promise<void> {
      return doFlush(contextKey, "manual");
    },

    cancel(contextKey: string): boolean {
      const entry = buffers.get(contextKey);
      if (!entry) return false;
      clearTimeout(entry.timer);
      buffers.delete(contextKey);
      return true;
    },

    keys(): string[] {
      return Array.from(buffers.keys());
    },
  };
}
