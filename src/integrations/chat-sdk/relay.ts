import { CardSpecError, toCard } from "@json-render/chat";
import type { CardChild, CardElement } from "chat";
import {
  getAgentById,
  getPendingChatRelayTasks,
  giveUpStaleChatRelays,
  markChatRelayAttempted,
  markChatRelayDelivered,
  markChatRelayGivenUp,
  recordChatRelayError,
} from "@/be/db";
import { getTaskUiSpec } from "@/be/task-ui-spec";
import { terminalReactionEvent } from "@/integrations/reaction-events";
import { chatThreadOfContextKey } from "@/tasks/context-key";
import type { AgentTask } from "@/types";
import { isEnvFlagEnabled } from "@/utils/env-flag";
import { scrubSecrets } from "@/utils/secret-scrubber";
import { UI_SPEC_CARD_LIMITS } from "@/utils/task-ui-spec";
import { workflowEventBus } from "@/workflows/event-bus";
import { shortId } from "./commands";
import { chatMessageLimit, splitChatMessage } from "./limits";
import { errorMessage } from "./logger";
import { postChatMessage } from "./outbound";
import { taskOutputChatFiles } from "./outbound-files";
import { setChatMessageReaction } from "./reactions";
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

/**
 * The first line of every relayed answer: the short task id `/status` shows
 * and the agent's name, e.g. `#a3f2b1c9 · Coder`. Two answers in one chat stay
 * apart even when the platform cannot show what they reply to.
 */
export function formatChatTaskTag(task: Pick<AgentTask, "id">, agentName?: string): string {
  return agentName ? `#${shortId(task)} · ${agentName}` : `#${shortId(task)}`;
}

/** The task tag, an optional status line, and the answer itself. */
function relayHeadAndBody(task: AgentTask, agentName?: string): { head: string; body: string } {
  const tag = formatChatTaskTag(task, agentName);
  const body = (task.output || task.failureReason || "").trim();
  if (task.status === "failed") return { head: `${tag}\n**Task failed.**`, body };
  if (task.status === "cancelled") return { head: `${tag}\n**Task cancelled.**`, body };
  return { head: tag, body: body || "Task completed." };
}

/** The text posted for a terminal task. Failed and cancelled tasks get a status line after the tag. */
export function formatChatRelayText(task: AgentTask, agentName?: string): string {
  const { head, body } = relayHeadAndBody(task, agentName);
  return body ? `${head}\n\n${body}` : head;
}

/** On Telegram, an answer body longer than this is posted collapsed. */
export const TELEGRAM_FOLD_CHARS = 1000;
/** A first paragraph up to this long stays visible above the collapsed rest. */
const FOLD_LEAD_MAX_CHARS = 280;
/** Room for the `<details>` markup and separators around one folded piece. */
const FOLD_MARKUP_CHARS = 80;

/**
 * The messages posted for a terminal task. On Telegram a long body goes into
 * collapsed `<details>` blocks: Bot API 10.1 rich messages render them folded
 * and parse the markdown inside. Each message gets its own block, so the
 * length split never cuts the markup in two.
 */
export function formatChatRelayMessages(
  task: AgentTask,
  adapter: string,
  agentName?: string,
): string[] {
  const { head, body } = relayHeadAndBody(task, agentName);
  if (adapter !== "telegram" || body.length <= TELEGRAM_FOLD_CHARS) {
    return [formatChatRelayText(task, agentName)];
  }
  const breakAt = body.indexOf("\n\n");
  const lead = breakAt > 0 && breakAt <= FOLD_LEAD_MAX_CHARS ? body.slice(0, breakAt) : "";
  const rest = lead ? body.slice(breakAt).trim() : body;
  const top = lead ? `${head}\n\n${lead}` : head;
  const room = chatMessageLimit(adapter) - top.length - FOLD_MARKUP_CHARS;
  const pieces = splitChatMessage(rest, room);
  return pieces.map((piece, index) => {
    const label = lead ? "Rest of the answer" : "Full answer";
    const summary = pieces.length > 1 ? `${label} (${index + 1}/${pieces.length})` : label;
    const block = `<details><summary>${summary}</summary>\n\n${piece}\n\n</details>`;
    return index === 0 ? `${top}\n\n${block}` : block;
  });
}

/**
 * The card's children with every callback Button removed, and any Actions row
 * left empty dropped. Chat SDK clicks have no handler, so a Button would do
 * nothing; a LinkButton stays.
 */
function withoutCallbackButtons(children: CardChild[]): CardChild[] {
  return children.flatMap((child): CardChild[] => {
    if (child.type === "section") {
      return [{ ...child, children: withoutCallbackButtons(child.children) }];
    }
    if (child.type !== "actions") return [child];
    const kept = child.children.filter((element) => element.type !== "button");
    return kept.length ? [{ ...child, children: kept }] : [];
  });
}

/**
 * The task's stored card for a Chat SDK channel, without callback Buttons.
 * `null` when `UI_SPEC_ENABLED` is off or the task has no spec. `card` is
 * `null` when the stored spec no longer converts; the caller then posts the
 * stored fallback text. Logs the issues, never the spec body.
 */
export async function chatRelayUiSpec(
  taskId: string,
): Promise<{ card: CardElement | null; fallbackText: string } | null> {
  if (!isEnvFlagEnabled("UI_SPEC_ENABLED", false)) return null;
  const stored = await getTaskUiSpec(taskId);
  if (!stored) return null;
  try {
    const card = toCard(stored.spec as Parameters<typeof toCard>[0], {
      limits: UI_SPEC_CARD_LIMITS,
    });
    return {
      card: { ...card, children: withoutCallbackButtons(card.children) },
      fallbackText: stored.fallbackText,
    };
  } catch (error) {
    if (!(error instanceof CardSpecError)) throw error;
    console.warn(
      `[chat-sdk] stored uiSpec for task ${taskId} no longer renders: ${error.issues.join(" | ")}`,
    );
    return { card: null, fallbackText: stored.fallbackText };
  }
}

/**
 * Post the task's card as one more message after the answer. When the card
 * post throws, post the fallback text as markdown instead. Never throws: the
 * answer already landed, so a card failure must not re-send it on retry.
 */
async function postChatRelayCard(
  adapter: string,
  threadId: string,
  task: AgentTask,
): Promise<void> {
  let uiSpec: Awaited<ReturnType<typeof chatRelayUiSpec>>;
  try {
    uiSpec = await chatRelayUiSpec(task.id);
  } catch (error) {
    console.error(`[chat-sdk] uiSpec of task ${task.id} unreadable: ${errorMessage(error)}`);
    return;
  }
  if (!uiSpec) return;
  if (uiSpec.card) {
    try {
      await postChatMessage({ adapter, threadId, text: [], card: uiSpec.card, taskId: task.id });
      return;
    } catch (error) {
      console.warn(`[chat-sdk] Card post of task ${task.id} failed: ${errorMessage(error)}`);
    }
  }
  if (!uiSpec.fallbackText) return;
  try {
    await postChatMessage({ adapter, threadId, text: uiSpec.fallbackText, taskId: task.id });
  } catch (error) {
    console.error(`[chat-sdk] Card fallback of task ${task.id} failed: ${errorMessage(error)}`);
  }
}

/**
 * Deliver every pending, out-of-backoff chat relay row for a running adapter.
 * Exported with an injectable clock so retry and give-up behavior is testable
 * without waiting.
 *
 * Delivery is at-least-once: a chunk failure re-posts the earlier chunks on
 * retry, and a crash between the send and `markChatRelayDelivered` re-sends the
 * message. The task's output attachments go after the text; a file that cannot
 * be sent gets a note in the thread and does not fail the delivery.
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
      const agent = task.agentId ? await getAgentById(task.agentId) : null;
      await postChatMessage({
        adapter: target.adapter,
        threadId: target.threadId,
        text: formatChatRelayMessages(task, target.adapter, agent?.name),
        taskId: task.id,
        files: await taskOutputChatFiles(task.id),
        // The inbound message this task answers. A lead follow-up, resume or
        // defer wake-up inherits it from its parent, so it answers the same ask.
        replyToMessageId: task.mentionMessageId,
      });
      await postChatRelayCard(target.adapter, target.threadId, task);
      stopTypingKeepalive(target.threadId);
      await markChatRelayDelivered(task.id, now);
      console.log(`[chat-sdk] Relayed ${task.status} task ${task.id} to ${target.adapter}`);
      // The ask's reaction ends with the answer. Never throws: delivery already landed.
      if (task.mentionMessageId) {
        await setChatMessageReaction(
          target.adapter,
          target.threadId,
          task.mentionMessageId,
          terminalReactionEvent(task.status),
        );
      }
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
