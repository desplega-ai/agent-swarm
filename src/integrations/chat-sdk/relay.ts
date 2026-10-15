import {
  getPendingChatRelayTasks,
  giveUpStaleChatRelays,
  markChatRelayAttempted,
  markChatRelayDelivered,
  markChatRelayGivenUp,
  recordChatRelayError,
} from "@/be/db";
import { chatThreadOfContextKey } from "@/tasks/context-key";
import type { AgentTask } from "@/types";
import { scrubSecrets } from "@/utils/secret-scrubber";
import { workflowEventBus } from "@/workflows/event-bus";
import { errorMessage } from "./logger";
import { postChatMessage } from "./outbound";
import { getChatInstance, getChatSdkHealth } from "./runtime";
import { sweepExpired } from "./state";
import { stopTypingKeepalive } from "./typing";

/**
 * Stop retrying a relay row this long after its obligation was created. Time,
 * not attempts: with exponential backoff a short platform outage would
 * otherwise burn a fixed attempt budget in minutes.
 */
export const RELAY_GIVE_UP_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Run `sweepExpired` on every Nth tick, including event-triggered ticks (so
 * about once a minute when only the 3 s interval ticks).
 */
const SWEEP_EVERY_N_TICKS = 20;

/** Coalesce bursts of terminal-task events into one early tick. */
const EARLY_TICK_DEBOUNCE_MS = 250;

/** The text posted for a terminal task. Failed and cancelled tasks get a status line first. */
export function formatChatRelayText(task: AgentTask): string {
  const body = (task.output || task.failureReason || "").trim();
  if (task.status === "failed") return body ? `**Task failed.**\n\n${body}` : "**Task failed.**";
  if (task.status === "cancelled") {
    return body ? `**Task cancelled.**\n\n${body}` : "**Task cancelled.**";
  }
  return body || "Task completed.";
}

/**
 * Deliver every pending, out-of-backoff chat relay row for a running adapter.
 * Exported with an injectable clock so retry and give-up behavior is testable
 * without waiting.
 *
 * Delivery is at-least-once: a chunk failure re-posts the earlier chunks on
 * retry, and a crash between the send and `markChatRelayDelivered` re-sends the
 * message.
 *
 * Once `signal` aborts, no further row is claimed. A send already in flight is
 * not cancelled (`postChatMessage` takes no signal); its row keeps the claim
 * and retries after the normal backoff.
 */
export async function processPendingChatRelays(
  now: number = Date.now(),
  signal?: AbortSignal,
): Promise<void> {
  // Rows older than the give-up age are retired first, so rows of a stopped
  // adapter do not stay pending forever.
  const retired = await giveUpStaleChatRelays(now, RELAY_GIVE_UP_AFTER_MS);
  if (retired > 0) console.warn(`[chat-sdk] Gave up relaying ${retired} stale task(s)`);

  const running = Object.entries(getChatSdkHealth())
    .filter(([, adapterHealth]) => adapterHealth?.status === "ok")
    .map(([name]) => name);

  for (const pending of await getPendingChatRelayTasks(now, 200, running)) {
    if (signal?.aborted) return;
    const { task } = pending;
    const target = chatThreadOfContextKey(task.contextKey);
    // `created_at` is ISO text with a `Z` suffix (migration 217 default).
    const createdAtMs = Date.parse(pending.createdAt);

    if (Number.isFinite(createdAtMs) && now - createdAtMs >= RELAY_GIVE_UP_AFTER_MS) {
      const reason = pending.lastError ?? "no successful delivery within 24 hours";
      if (await markChatRelayGivenUp(task.id, reason, now)) {
        console.warn(scrubSecrets(`[chat-sdk] Gave up relaying task ${task.id}: ${reason}`));
      }
      if (target) stopTypingKeepalive(target.threadId);
      continue;
    }
    if (!target) {
      // The trigger only enqueues chat-sdk keys; a key that no longer parses
      // can never be delivered.
      await markChatRelayGivenUp(task.id, "task has no chat-sdk contextKey", now);
      continue;
    }
    // Stopping adapter: skip without counting an attempt.
    if (!getChatInstance(target.adapter)) continue;

    if (!(await markChatRelayAttempted(task.id, now))) continue;
    try {
      await postChatMessage({
        adapter: target.adapter,
        threadId: target.threadId,
        text: formatChatRelayText(task),
        taskId: task.id,
      });
      stopTypingKeepalive(target.threadId);
      await markChatRelayDelivered(task.id, now);
      console.log(`[chat-sdk] Relayed ${task.status} task ${task.id} to ${target.adapter}`);
    } catch (error) {
      const message = errorMessage(error);
      await recordChatRelayError(task.id, message, now);
      console.error(`[chat-sdk] Relay of task ${task.id} failed: ${message}`);
    }
  }
}

let interval: ReturnType<typeof setInterval> | undefined;
let earlyTick: ReturnType<typeof setTimeout> | undefined;
let processing: Promise<void> | undefined;
let stopController: AbortController | undefined;
let tickCount = 0;

async function tick(): Promise<void> {
  if (processing) return;
  tickCount += 1;
  const now = Date.now();
  processing = (async () => {
    try {
      await processPendingChatRelays(now, stopController?.signal);
      if (tickCount % SWEEP_EVERY_N_TICKS === 0) await sweepExpired(now);
    } catch (error) {
      console.error(`[chat-sdk] Relay tick failed: ${errorMessage(error)}`);
    }
  })();
  try {
    await processing;
  } finally {
    processing = undefined;
  }
}

function scheduleEarlyTick(): void {
  if (!interval || earlyTick) return;
  earlyTick = setTimeout(() => {
    earlyTick = undefined;
    void tick();
  }, EARLY_TICK_DEBOUNCE_MS);
}

const TERMINAL_EVENTS = ["task.completed", "task.failed", "task.cancelled"] as const;

/** Start the relay watcher. Idempotent. A terminal task event triggers an early tick. */
export function startChatRelayWatcher(intervalMs = 3000): void {
  if (interval) return;
  tickCount = 0;
  stopController = new AbortController();
  interval = setInterval(() => void tick(), intervalMs);
  for (const event of TERMINAL_EVENTS) workflowEventBus.on(event, scheduleEarlyTick);
  void tick();
}

/**
 * Stop the watcher: no new tick, no new claim. The returned promise settles
 * when an in-flight tick finishes, which an unanswered platform call can delay
 * without bound, so shutdown waits for it under its own deadline.
 */
export async function stopChatRelayWatcher(): Promise<void> {
  stopController?.abort();
  if (interval) clearInterval(interval);
  interval = undefined;
  if (earlyTick) clearTimeout(earlyTick);
  earlyTick = undefined;
  for (const event of TERMINAL_EVENTS) workflowEventBus.off(event, scheduleEarlyTick);
  if (processing) await processing;
}
