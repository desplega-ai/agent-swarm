/**
 * Delivers task.completed / task.failed to matching MCP Events webhook
 * subscriptions. Listens on the in-process workflow event bus, which emits
 * post-commit, so a rolled-back completion never reaches a client.
 *
 * Retries are in-process and bounded (5 attempts over about 14 minutes). There
 * is no durable outbox: an event emitted while the API restarts, or whose
 * retries run past a restart, is lost. get-task-details stays the source of
 * truth.
 *
 * shortcut: no durable outbox, upgrade when a client needs at-least-once delivery.
 */

import { createHash } from "node:crypto";
import { getDbClient, getTaskById, getUserById } from "@/be/db";
import { isLiveUserToken } from "@/be/users";
import { getAppUrl } from "@/utils/constants";
import { scrubSecrets } from "@/utils/secret-scrubber";
import { workflowEventBus } from "@/workflows/event-bus";
import { isMcpUserEventsEnabled, parseTaskEventArguments, type TaskEventName } from "./catalog";
import {
  getSubscription,
  listLiveSubscriptions,
  recordDeliveryOutcome,
  type SubscriptionRow,
  unsealSecret,
} from "./store";
import { MAX_DELIVERY_BODY_BYTES, parseWebhookSecret, postSignedWebhook } from "./webhook";

/** Delays before attempts 2..5. Sum ≈ 14 min, inside SEP-3415's 10-15 min guidance. */
const DEFAULT_RETRY_DELAYS_MS = [10_000, 60_000, 240_000, 540_000];
const MAX_OUTPUT_CHARS = 16_000;
const MAX_TASK_CHARS = 2_000;
const MAX_ANCESTOR_HOPS = 32;

let retryDelaysMs = DEFAULT_RETRY_DELAYS_MS;
const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
let listening = false;

/** Tests only: shorten the retry schedule. */
export function __setRetryDelaysForTests(delays: number[] | null): void {
  retryDelaysMs = delays ?? DEFAULT_RETRY_DELAYS_MS;
}

function truncate(text: string, max: number): { text: string; truncated: boolean } {
  return text.length > max
    ? { text: text.slice(0, max), truncated: true }
    : { text, truncated: false };
}

/** True when `taskId` is `filterTaskId` or one of its descendants. */
async function isUnderTask(taskId: string, filterTaskId: string): Promise<boolean> {
  let current: string | null = taskId;
  for (let hop = 0; current && hop <= MAX_ANCESTOR_HOPS; hop++) {
    if (current === filterTaskId) return true;
    const row: { parentTaskId: string | null } | null = await getDbClient().get<{
      parentTaskId: string | null;
    }>("SELECT parentTaskId FROM agent_tasks WHERE id = ?", [current]);
    current = row?.parentTaskId ?? null;
  }
  return false;
}

function signingSecrets(row: SubscriptionRow, nowIso: string): Buffer[] {
  const secrets = [unsealSecret(row.secretSealed)];
  if (row.previousSecretSealed && row.previousSecretUntil && row.previousSecretUntil > nowIso) {
    secrets.push(unsealSecret(row.previousSecretSealed));
  }
  return secrets.map(parseWebhookSecret).filter((s): s is Buffer => s !== null);
}

/** One attempt; schedules the next on a retryable failure. */
async function attemptDelivery(
  subscriptionId: string,
  eventId: string,
  body: string,
  attempt: number,
): Promise<void> {
  const nowIso = new Date().toISOString();
  // Re-read each attempt: an unsubscribe or expiry mid-retry stops delivery.
  const row = await getSubscription(subscriptionId);
  if (!row || row.expiresAt <= nowIso) return;
  // A revoked connection token stops its subscriptions' deliveries at once.
  if (!(await isLiveUserToken(row.tokenId, row.userId))) return;
  const result = await postSignedWebhook({
    url: row.url,
    subscriptionId: row.id,
    // ChatGPT and the design sketch set webhook-id to the eventId. Ours is
    // already unique per (subscription, event), so it is a per-message id.
    webhookId: eventId,
    secrets: signingSecrets(row, nowIso),
    body,
  });
  const atIso = new Date().toISOString();
  if (result.ok) {
    await recordDeliveryOutcome(row.id, { ok: true, atIso });
    return;
  }
  // 410: the receiver declined this event. 413: too large. Neither is retried.
  if (result.status === 410 || result.status === 413) return;
  await recordDeliveryOutcome(row.id, { ok: false, category: result.category, atIso });
  const delay = retryDelaysMs[attempt];
  if (delay === undefined) return;
  const timer = setTimeout(() => {
    pendingTimers.delete(timer);
    void attemptDelivery(subscriptionId, eventId, body, attempt + 1).catch(logError);
  }, delay);
  timer.unref?.();
  pendingTimers.add(timer);
}

function logError(err: unknown): void {
  console.error(
    "[mcp-events] delivery failed:",
    scrubSecrets(err instanceof Error ? err.message : String(err)),
  );
}

type TaskEventPayload = { taskId?: unknown; output?: unknown; failureReason?: unknown };

/**
 * Finds the live subscriptions an event matches and starts one delivery per
 * subscription. Resolves once every first attempt has finished.
 */
export async function dispatchTaskEvent(name: TaskEventName, payload: unknown): Promise<void> {
  if (!isMcpUserEventsEnabled()) return;
  const { taskId, output, failureReason } = (payload ?? {}) as TaskEventPayload;
  if (typeof taskId !== "string") return;
  const task = await getTaskById(taskId);
  if (!task?.requestedByUserId) return;
  const user = await getUserById(task.requestedByUserId);
  // A deactivated user's subscriptions stay silent until they lapse.
  if (!user || user.status !== "active") return;

  const now = new Date();
  const subscriptions = await listLiveSubscriptions(user.id, name, now.toISOString());
  if (subscriptions.length === 0) return;

  const rawDetail = name === "task.completed" ? output : failureReason;
  const detailText = scrubSecrets(typeof rawDetail === "string" ? rawDetail : "");
  const detail = truncate(detailText, MAX_OUTPUT_CHARS);
  const description = truncate(scrubSecrets(task.task ?? ""), MAX_TASK_CHARS);
  const data: Record<string, unknown> = {
    taskId: task.id,
    parentTaskId: task.parentTaskId ?? null,
    status: name === "task.completed" ? "completed" : "failed",
    task: description.text,
    url: `${getAppUrl()}/tasks/${encodeURIComponent(task.id)}`,
    [name === "task.completed" ? "output" : "failureReason"]: detail.text,
    truncated: detail.truncated || description.truncated,
  };
  const timestamp = task.finishedAt ?? now.toISOString();

  const attempts: Promise<void>[] = [];
  for (const subscription of subscriptions) {
    const args = parseTaskEventArguments(JSON.parse(subscription.argumentsJson));
    if (!args) continue;
    if (args.taskId && !(await isUnderTask(task.id, args.taskId))) continue;
    const eventId = `evt_${createHash("sha256")
      .update(`${subscription.id}\n${name}\n${task.id}`)
      .digest("hex")
      .slice(0, 32)}`;
    let body = JSON.stringify({ eventId, name, timestamp, data, cursor: null });
    if (Buffer.byteLength(body, "utf8") > MAX_DELIVERY_BODY_BYTES) {
      body = JSON.stringify({
        eventId,
        name,
        timestamp,
        data: { ...data, output: undefined, failureReason: undefined, truncated: true },
        cursor: null,
      });
    }
    attempts.push(attemptDelivery(subscription.id, eventId, body, 0).catch(logError));
  }
  await Promise.all(attempts);
}

const onCompleted = (payload: unknown) => {
  void dispatchTaskEvent("task.completed", payload).catch(logError);
};
const onFailed = (payload: unknown) => {
  void dispatchTaskEvent("task.failed", payload).catch(logError);
};

/** Subscribes the dispatcher to task lifecycle events. Idempotent, API server only. */
export function initMcpEventsDispatcher(): void {
  if (listening) return;
  listening = true;
  workflowEventBus.on("task.completed", onCompleted);
  workflowEventBus.on("task.failed", onFailed);
}

/** Unsubscribes and cancels pending retries (tests, shutdown). */
export function stopMcpEventsDispatcher(): void {
  if (listening) {
    workflowEventBus.off("task.completed", onCompleted);
    workflowEventBus.off("task.failed", onFailed);
    listening = false;
  }
  for (const timer of pendingTimers) clearTimeout(timer);
  pendingTimers.clear();
}
