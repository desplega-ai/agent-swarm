import { ensure } from "@desplega.ai/business-use";
import type { WebClient } from "@slack/web-api";
import {
  bindSlackMessageTimestamp,
  checkDependencies,
  createLogEntry,
  deleteSlackMessageRecord,
  ensureSlackDelegationActivation,
  ensureSlackRenderV2Activation,
  getAgentById,
  getSlackOutcomeMessage,
  getSlackTasksInThread,
  getSlackTasksMissingTree,
  getSlackTreeMessage,
  getSlackTreeMessageByThread,
  getSlackTreeMessages,
  getTaskAttachments,
  getTaskById,
  isPendingSlackMessage,
  markSlackTreeRendered,
  reserveSlackMessage,
  type SlackConclusionKind,
  type SlackMessageRecord,
  updateSlackMessageRecord,
} from "../be/db";
import { slackContextKey } from "../tasks/context-key";
import type { AgentTask, TaskAttachment } from "../types";
import { isEnvFlagEnabled } from "../utils/env-flag";
import { taskAttachmentDisplayUrl } from "../utils/task-attachment-links";
import {
  finalizeSlackMessageReaction,
  finalizeSlackSteerReactions,
  finalizeTerminalSlackReactions,
} from "./ack";
import { getSlackApp } from "./app";
import {
  getTaskLink,
  getTaskUrl,
  MAX_SECTION_LENGTH,
  markdownToSlack,
  splitSlackSectionText,
} from "./blocks";
import { buildAskClosure, type ClosureState, closureState } from "./closure";
import { getAgentDisplayName, getAgentEmoji } from "./responses";

const TREE_UPDATE_DEBOUNCE_MS = 500;
const TREE_UPDATE_MIN_INTERVAL_MS = 3_000;
const MAX_SLACK_RETRIES = 3;
const MAX_RETRY_DELAY_MS = 30_000;
const MAX_TITLE_LENGTH = 72;
const MAX_OUTCOME_MARKDOWN_LENGTH = 12_000;
const MAX_TREE_NODE_LINE_LENGTH = 1_000;
const MAX_TREE_PREFIX_LENGTH = 120;
const MAX_TREE_PROGRESS_LENGTH = 60;
const CHILD_CARDS_PER_TICK = 3;
const CHILD_CARDS_PER_ASK = 10;
const CONCLUSION_DIGEST_LENGTH = 300;
const TREE_INDENT = { topLevel: 1, levelStep: 3 } as const;
const FIGURE_SPACE = "\u2007";
const SLACK_RENDER_METADATA_EVENT = "agent_swarm_render_v2";

const treeCreationPromises = new Map<string, Promise<SlackMessageRecord | null>>();
const pendingTreeUpdates = new Map<string, ReturnType<typeof setTimeout>>();
const treeUpdateTails = new Map<string, Promise<void>>();
const lastTreeText = new Map<string, string>();
const lastTreeUpdateAt = new Map<string, number>();
let cachedTeamId: string | undefined;

type SlackApiResult = Record<string, unknown> & { ok?: boolean; ts?: string; permalink?: string };

type SlackThreadMessage = {
  ts?: string;
  text?: string;
  metadata?: { event_type?: string; event_payload?: Record<string, unknown> };
};

export function isSlackRenderV2Enabled(): boolean {
  return isEnvFlagEnabled("SLACK_RENDER_V2", false);
}

export function isSlackDelegationEnabled(): boolean {
  return isEnvFlagEnabled("SLACK_RENDER_V2_DELEGATION", false);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(error: unknown, attempt: number): number | null {
  const candidate = error as {
    code?: string;
    retryAfter?: number;
    data?: { error?: string; retry_after?: number };
  };
  if (
    candidate.code !== "slack_webapi_rate_limited_error" &&
    candidate.data?.error !== "ratelimited"
  ) {
    return null;
  }
  const seconds = candidate.retryAfter ?? candidate.data?.retry_after ?? 2 ** attempt;
  return Math.min(Math.max(seconds * 1_000, 0), MAX_RETRY_DELAY_MS);
}

export async function callSlackWithRetry(
  client: WebClient,
  method: string,
  payload: Record<string, unknown>,
): Promise<SlackApiResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await client.apiCall(method, payload)) as SlackApiResult;
    } catch (error) {
      const delay = retryDelayMs(error, attempt);
      if (delay === null || attempt >= MAX_SLACK_RETRIES) throw error;
      console.warn(`[Slack] ${method} rate limited; retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
}

function slackTreeStallMinutes(): number {
  return Number(process.env.SLACK_TREE_STALL_MIN) || 15;
}

function isStalledMember(task: AgentTask, now: Date): boolean {
  if (task.status !== "in_progress") return false;
  const idleMin = (now.getTime() - new Date(task.lastUpdatedAt).getTime()) / 60_000;
  return idleMin >= slackTreeStallMinutes();
}

/**
 * One glyph per task line in the tree, replacing the old `statusIcon`.
 * Blocked detection reuses `checkDependencies` — the same source `get-tasks`
 * `readyOnly` uses — rather than re-deriving it from the tree's own task list,
 * since a dependency can point outside the current Slack thread.
 */
async function taskStateGlyph(task: AgentTask, now: Date): Promise<string> {
  switch (task.status) {
    case "backlog":
    case "unassigned":
    case "offered":
    case "reviewing":
      return "🕒";
    case "pending": {
      const { ready } = await checkDependencies(task.id);
      return ready ? "▶️" : "⛔";
    }
    case "in_progress":
      return isStalledMember(task, now) ? "⚠️" : "🔄";
    case "paused":
      return "⏸️";
    case "completed":
      return "✅";
    case "failed":
      return "❌";
    case "cancelled":
      return "🚫";
    case "superseded":
      return "↪️";
    default:
      return "🕒";
  }
}

export function formatV2Duration(start: Date, end: Date): string {
  const totalSeconds = Math.max(0, Math.floor((end.getTime() - start.getTime()) / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60)
    return seconds === 0 ? `${minutes}m` : `${minutes}m${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h${remainingMinutes}m`;
}

function terminalEnd(task: AgentTask, now: Date): Date {
  const end = isTerminalTreeStatus(task.status)
    ? (task.finishedAt ?? task.lastUpdatedAt)
    : undefined;
  return end ? new Date(end) : now;
}

function isTerminalTreeStatus(status: AgentTask["status"]): boolean {
  return ["completed", "failed", "cancelled", "superseded"].includes(status);
}

function cleanTaskDescription(task: AgentTask): string {
  if (task.title?.trim()) return task.title.trim();
  let text = task.task
    .replace(/<thread_context>[\s\S]*?<\/thread_context>/g, "")
    .trim()
    .replace(/^\[Thread follow-up[^\]]*\]\s*/i, "")
    .replace(/^[-#*\s]+/, "")
    .trim();
  const firstLine =
    text
      .split(/\n+/)
      .find((line) => line.trim())
      ?.trim() ?? "task";
  text = firstLine.replace(/\s+/g, " ");
  return text.length > MAX_TITLE_LENGTH
    ? `${text.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`
    : text;
}

function truncateTreeLabel(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim() || "Worker";
  return normalized.length > MAX_TITLE_LENGTH
    ? `${normalized.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`
    : normalized;
}

type RenderNode = { task: AgentTask; children: RenderNode[] };

function buildRenderForest(tasks: AgentTask[]): RenderNode[] {
  const nodes = new Map(tasks.map((task) => [task.id, { task, children: [] as RenderNode[] }]));
  const roots: RenderNode[] = [];
  for (const task of tasks) {
    const node = nodes.get(task.id)!;
    const isAsk = task.source === "slack";
    const parent = task.parentTaskId ? nodes.get(task.parentTaskId) : undefined;
    if (!isAsk && parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

async function renderNodeLabel(node: RenderNode, isAsk: boolean): Promise<string> {
  if (isAsk) return markdownToSlack(cleanTaskDescription(node.task));
  return truncateTreeLabel(
    node.task.agentId ? ((await getAgentById(node.task.agentId))?.name ?? "Worker") : "Worker",
  );
}

function renderProgress(progress: string | undefined): string | undefined {
  const normalized = markdownToSlack(progress ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return undefined;
  if (normalized.length <= MAX_TREE_PROGRESS_LENGTH) return `${normalized}…`;
  const boundary = normalized.lastIndexOf(" ", MAX_TREE_PROGRESS_LENGTH);
  const cut = boundary >= MAX_TREE_PROGRESS_LENGTH / 2 ? boundary : MAX_TREE_PROGRESS_LENGTH;
  return `${normalized.slice(0, cut).trimEnd()}…`;
}

async function renderNodeLines(
  node: RenderNode,
  depth: number,
  now: Date,
  isAsk: boolean,
): Promise<string[]> {
  const duration = formatV2Duration(new Date(node.task.createdAt), terminalEnd(node.task, now));
  const indent = FIGURE_SPACE.repeat(
    TREE_INDENT.topLevel + Math.max(0, depth - 1) * TREE_INDENT.levelStep,
  );
  const boundedPrefix =
    indent.length > MAX_TREE_PREFIX_LENGTH
      ? `${indent.slice(0, MAX_TREE_PREFIX_LENGTH - 1)}…`
      : indent;
  let line = `${boundedPrefix}↳ ${await taskStateGlyph(node.task, now)} ${await renderNodeLabel(node, isAsk)} · ${duration} · ${getTaskLink(node.task.id)}`;
  const progress = renderProgress(node.task.progress);
  const suffix = isTerminalTreeStatus(node.task.status) ? "" : progress ? ` · ${progress}` : "";
  if (suffix && line.length + suffix.length <= MAX_TREE_NODE_LINE_LENGTH) {
    line += suffix;
  }
  if (line.length > MAX_TREE_NODE_LINE_LENGTH) {
    line = `${line.slice(0, MAX_TREE_NODE_LINE_LENGTH - 1).trimEnd()}…`;
  }
  const lines = [line];
  for (const child of node.children) {
    lines.push(...(await renderNodeLines(child, depth + 1, now, false)));
  }
  return lines;
}

function normalizeV2Text(value: string): string {
  return value.trim().replace(/\n{3,}/g, "\n\n");
}

/**
 * The tree's first line, replacing the old constant "🧵 worked for <duration>".
 * A timed-out ask closure outranks a stalled member outranks plain activity —
 * each of those states implies a non-terminal member is still sitting there,
 * so "concluded" here means "the engine gave up waiting", not "nothing left".
 */
function threadHeaderText(tasks: AgentTask[], now: Date, duration: string): string {
  const settleSec = Number(process.env.SLACK_CONCLUSION_SETTLE_SEC) || 10;
  const timeoutMin = Number(process.env.SLACK_CONCLUSION_TIMEOUT_MIN) || 240;
  const asks = tasks.filter((task) => task.source === "slack");
  const timedOut = asks.some(
    (ask) =>
      closureState(ask, buildAskClosure(ask, tasks), now, settleSec, timeoutMin) === "timedOut",
  );
  if (timedOut) return `🧵 ⚠️ concluded with unfinished work — ${duration}`;
  if (tasks.some((task) => isStalledMember(task, now))) return `🧵 ⚠️ stalled — ${duration}`;
  if (tasks.some((task) => !isTerminalTreeStatus(task.status)))
    return `🧵 🔄 working — ${duration}`;
  const hasFailure = tasks.some((task) => task.status === "failed");
  return hasFailure ? `🧵 ❌ done with failures — ${duration}` : `🧵 ✅ done — ${duration}`;
}

export async function renderThreadTree(
  tasks: AgentTask[],
  _outcomeLinks: ReadonlyMap<string, string> = new Map(),
  now = new Date(),
  _triggerLinks: ReadonlyMap<string, string> = new Map(),
): Promise<string> {
  if (tasks.length === 0) return `🧵 🔄 working — 0s`;
  const asks = tasks.filter((task) => task.source === "slack");
  const first = asks[0] ?? tasks[0]!;
  const hasActiveTask = tasks.some((task) => !isTerminalTreeStatus(task.status));
  const threadEnd = hasActiveTask
    ? now
    : tasks.reduce((latest, task) => {
        const end = terminalEnd(task, now);
        return end > latest ? end : latest;
      }, new Date(first.createdAt));
  const threadDuration = formatV2Duration(new Date(first.createdAt), threadEnd);
  const lines = [threadHeaderText(tasks, now, threadDuration)];
  const roots = buildRenderForest(tasks);
  for (const root of roots) {
    lines.push(...(await renderNodeLines(root, 1, now, root.task.source === "slack")));
  }
  const text = normalizeV2Text(lines.join("\n"));
  if (text.length <= MAX_SECTION_LENGTH) return text;

  const header = lines[0]!;
  const recentLines: string[] = [];
  for (let index = tasks.length - 1; index >= 0; index--) {
    const task = tasks[index]!;
    const recentLine = (
      await renderNodeLines({ task, children: [] }, 1, now, task.source === "slack")
    )[0]!;
    const candidateLines = [recentLine, ...recentLines];
    const omitted = index;
    const marker = `… _${omitted} older task${omitted === 1 ? "" : "s"} collapsed_`;
    const candidate = [header, ...(omitted > 0 ? [marker] : []), ...candidateLines].join("\n");
    if (candidate.length > MAX_SECTION_LENGTH) break;
    recentLines.unshift(recentLine);
  }

  const omitted = tasks.length - recentLines.length;
  const marker = `… _${omitted} older task${omitted === 1 ? "" : "s"} collapsed_`;
  return normalizeV2Text([header, ...(omitted > 0 ? [marker] : []), ...recentLines].join("\n"));
}

function treeBlocks(text: string): unknown[] {
  return splitSlackSectionText(text).map((chunk) => ({
    type: "context",
    elements: [{ type: "mrkdwn", text: chunk }],
  }));
}

async function resolvePermalink(client: WebClient, channelId: string, ts: string): Promise<string> {
  const result = await callSlackWithRetry(client, "chat.getPermalink", {
    channel: channelId,
    message_ts: ts,
  });
  if (typeof result.permalink !== "string" || !result.permalink) {
    throw new Error(`Slack did not return a permalink for ${channelId}/${ts}`);
  }
  return result.permalink;
}

async function ensureTreePermalink(
  client: WebClient,
  tree: SlackMessageRecord,
): Promise<SlackMessageRecord> {
  if (tree.permalink) return tree;
  const permalink = await resolvePermalink(client, tree.channelId, tree.ts);
  return (await updateSlackMessageRecord(tree.id, { permalink, touchUpdatedAt: false })) ?? tree;
}

function physicalThreadKey(channelId: string, threadTs: string): string {
  return `${channelId}:${threadTs}`;
}

function isSlackMessageNotFound(error: unknown): boolean {
  return (error as { data?: { error?: string } }).data?.error === "message_not_found";
}

async function findReservedSlackMessage(
  client: WebClient,
  reservation: SlackMessageRecord,
  outcomeMarker?: string,
): Promise<SlackThreadMessage | undefined> {
  let cursor: string | undefined;
  const oldest = Math.max(0, new Date(reservation.createdAt).getTime() / 1_000 - 5);
  do {
    const response = await callSlackWithRetry(client, "conversations.replies", {
      channel: reservation.channelId,
      ts: reservation.threadTs,
      include_all_metadata: true,
      oldest: String(oldest),
      inclusive: true,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    const messages = Array.isArray(response.messages)
      ? (response.messages as SlackThreadMessage[])
      : [];
    const found = messages.find((message) => {
      if (!message.ts) return false;
      if (outcomeMarker) return message.text?.includes(outcomeMarker) ?? false;
      return (
        message.metadata?.event_type === SLACK_RENDER_METADATA_EVENT &&
        message.metadata.event_payload?.message_id === reservation.id
      );
    });
    if (found) return found;
    const nextCursor = (response.response_metadata as { next_cursor?: unknown } | undefined)
      ?.next_cursor;
    cursor = typeof nextCursor === "string" && nextCursor ? nextCursor : undefined;
  } while (cursor);
  return undefined;
}

async function discardTreeRecord(tree: SlackMessageRecord): Promise<void> {
  const timer = pendingTreeUpdates.get(tree.id);
  if (timer) clearTimeout(timer);
  pendingTreeUpdates.delete(tree.id);
  lastTreeText.delete(tree.id);
  lastTreeUpdateAt.delete(tree.id);
  await deleteSlackMessageRecord(tree.id);
}

async function findThreadTree(
  contextKey: string,
  channelId: string,
  threadTs: string,
): Promise<SlackMessageRecord | null> {
  return (
    (await getSlackTreeMessage(contextKey)) ??
    (await getSlackTreeMessageByThread(channelId, threadTs))
  );
}

async function createThreadTree(task: AgentTask): Promise<SlackMessageRecord | null> {
  const app = getSlackApp();
  if (!app || !task.slackChannelId || !task.slackThreadTs) return null;
  const contextKey =
    task.contextKey ??
    slackContextKey({
      channelId: task.slackChannelId,
      threadTs: task.slackThreadTs,
    });
  const existing = await findThreadTree(contextKey, task.slackChannelId, task.slackThreadTs);
  if (existing && !isPendingSlackMessage(existing)) return existing;

  const renderedThrough = new Date().toISOString();
  const tasks = await getSlackTasksInThread(task.slackChannelId, task.slackThreadTs);
  const agent = task.agentId ? await getAgentById(task.agentId) : undefined;
  const text = await renderThreadTree(tasks);
  const reserved = existing
    ? { record: existing, created: false }
    : await reserveSlackMessage({
        contextKey,
        channelId: task.slackChannelId,
        threadTs: task.slackThreadTs,
        kind: "tree",
        taskId: task.id,
      });
  const reservation = reserved.record;
  const reconciled = reserved.created
    ? undefined
    : await findReservedSlackMessage(app.client, reservation);
  let remote = reconciled;
  if (!remote) {
    remote = await callSlackWithRetry(app.client, "chat.postMessage", {
      channel: task.slackChannelId,
      thread_ts: task.slackThreadTs,
      text,
      blocks: treeBlocks(text),
      unfurl_links: false,
      unfurl_media: false,
      ...(agent ? { username: getAgentDisplayName(agent), icon_emoji: getAgentEmoji(agent) } : {}),
      metadata: {
        event_type: SLACK_RENDER_METADATA_EVENT,
        event_payload: { message_id: reservation.id, kind: "tree" },
      },
    });
  }
  if (typeof remote.ts !== "string" || !remote.ts) {
    throw new Error("Slack did not return a timestamp for the thread tree");
  }
  if (reconciled) {
    await callSlackWithRetry(app.client, "chat.update", {
      channel: task.slackChannelId,
      ts: remote.ts,
      text,
      blocks: treeBlocks(text),
      unfurl_links: false,
      unfurl_media: false,
    });
  }
  let record = await bindSlackMessageTimestamp(reservation.id, remote.ts, {
    renderedThrough,
  });
  if (!record) {
    record = await getSlackTreeMessageByThread(task.slackChannelId, task.slackThreadTs);
  }
  if (!record || isPendingSlackMessage(record)) {
    throw new Error("Failed to persist the thread tree timestamp");
  }
  record = await ensureTreePermalink(app.client, record);
  lastTreeText.set(record.id, text);
  lastTreeUpdateAt.set(record.id, Date.now());
  return record;
}

export async function ensureSlackThreadTree(taskIds: string[]): Promise<SlackMessageRecord | null> {
  const task = (await Promise.all(taskIds.map(getTaskById))).find(
    (candidate): candidate is AgentTask => !!candidate,
  );
  if (!task?.slackChannelId || !task.slackThreadTs) return null;
  const contextKey =
    task.contextKey ??
    slackContextKey({
      channelId: task.slackChannelId,
      threadTs: task.slackThreadTs,
    });
  const existing = await findThreadTree(contextKey, task.slackChannelId, task.slackThreadTs);
  if (existing && !isPendingSlackMessage(existing)) {
    const app = getSlackApp();
    try {
      const resolved = app ? await ensureTreePermalink(app.client, existing) : existing;
      scheduleSlackTreeUpdate(resolved);
      return resolved;
    } catch (error) {
      if (!isSlackMessageNotFound(error)) throw error;
      await discardTreeRecord(existing);
      return ensureSlackThreadTree(taskIds);
    }
  }
  const creationKey = physicalThreadKey(task.slackChannelId, task.slackThreadTs);
  const inFlight = treeCreationPromises.get(creationKey);
  if (inFlight) return inFlight;
  const creation = createThreadTree(task).finally(() => treeCreationPromises.delete(creationKey));
  treeCreationPromises.set(creationKey, creation);
  return creation;
}

function scheduleSlackTreeUpdate(
  tree: SlackMessageRecord,
  delayMs = TREE_UPDATE_DEBOUNCE_MS,
): void {
  const existing = pendingTreeUpdates.get(tree.id);
  if (existing) clearTimeout(existing);
  pendingTreeUpdates.set(
    tree.id,
    setTimeout(
      () => {
        pendingTreeUpdates.delete(tree.id);
        void updateThreadTree(tree).catch((error) => {
          console.error(`[Slack] Failed to run debounced v2 tree update ${tree.id}:`, error);
        });
      },
      Math.max(0, delayMs),
    ),
  );
}

async function withTreeUpdateLock<T>(
  channelId: string,
  threadTs: string,
  work: () => Promise<T>,
): Promise<T> {
  const key = physicalThreadKey(channelId, threadTs);
  const previous = treeUpdateTails.get(key) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(work);
  const tail = run.then(
    () => {},
    () => {},
  );
  treeUpdateTails.set(key, tail);
  try {
    return await run;
  } finally {
    if (treeUpdateTails.get(key) === tail) treeUpdateTails.delete(key);
  }
}

async function replaceMissingTree(tree: SlackMessageRecord): Promise<SlackMessageRecord | null> {
  await discardTreeRecord(tree);
  const taskIds = (await getSlackTasksInThread(tree.channelId, tree.threadTs)).map(
    (task) => task.id,
  );
  return taskIds.length > 0 ? ensureSlackThreadTree(taskIds) : null;
}

async function updateThreadTree(
  tree: SlackMessageRecord,
  bypassThrottle = false,
): Promise<boolean> {
  const result = await withTreeUpdateLock(tree.channelId, tree.threadTs, async () => {
    const app = getSlackApp();
    if (!app) return "unchanged" as const;
    const current = await getSlackTreeMessageByThread(tree.channelId, tree.threadTs);
    if (!current || current.id !== tree.id) return "unchanged" as const;
    if (isPendingSlackMessage(current)) return "pending" as const;

    const renderedThrough = new Date().toISOString();
    const tasks = await getSlackTasksInThread(current.channelId, current.threadTs);
    if (tasks.length === 0) return "unchanged" as const;
    const text = await renderThreadTree(tasks);
    const lastText = lastTreeText.get(current.id);
    const lastUpdate = lastTreeUpdateAt.get(current.id) ?? 0;
    if (text === lastText) {
      await markSlackTreeRendered(current.id, renderedThrough);
      return "unchanged" as const;
    }
    const remaining = TREE_UPDATE_MIN_INTERVAL_MS - (Date.now() - lastUpdate);
    if (remaining > 0 && !bypassThrottle) {
      scheduleSlackTreeUpdate(current, remaining);
      return "throttled" as const;
    }
    try {
      await callSlackWithRetry(app.client, "chat.update", {
        channel: current.channelId,
        ts: current.ts,
        text,
        blocks: treeBlocks(text),
        unfurl_links: false,
        unfurl_media: false,
      });
    } catch (error) {
      if (isSlackMessageNotFound(error)) return "missing" as const;
      throw error;
    }
    lastTreeText.set(current.id, text);
    lastTreeUpdateAt.set(current.id, Date.now());
    await markSlackTreeRendered(current.id, renderedThrough);
    return "updated" as const;
  });

  if (result === "missing") {
    await replaceMissingTree(tree);
    return false;
  }
  return result === "updated";
}

function isOutcomeStatus(
  status: AgentTask["status"],
): status is "completed" | "failed" | "cancelled" {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isAskOutcomeStatus(status: AgentTask["status"]): boolean {
  return isOutcomeStatus(status) || status === "in_progress";
}

function outcomeText(value: string | null | undefined, fallback: string): string {
  return value?.trim() ? value : fallback;
}

async function outcomeContent(task: AgentTask, slackReplySent: boolean): Promise<string> {
  if (task.status === "failed") {
    return `❌ **Failed**\n\n${outcomeText(task.failureReason, "Task failed.")}`;
  }
  if (task.status === "cancelled") {
    return `🚫 **Cancelled**\n\n${outcomeText(task.failureReason, "Task was cancelled.")}`;
  }
  if (slackReplySent && task.status === "completed") {
    const agentName = task.agentId
      ? ((await getAgentById(task.agentId))?.name ?? "Agent")
      : "Agent";
    return `✅ ${agentName} completed`;
  }
  return `✅\n\n${outcomeText(task.output, "Task completed.")}`;
}

async function agentDisplayNameFor(task: AgentTask): Promise<string> {
  return task.agentId ? ((await getAgentById(task.agentId))?.name ?? "Agent") : "Agent";
}

/**
 * A delegated (non-ask) task's own result card: `↳ ✅ <agent> — result` or
 * `↳ ❌ <agent> — failed`, per plan section 3.4. Eligibility already limits
 * callers to `completed` / `failed` children, so no cancelled/other branch.
 *
 * `slackReplySent` here is the fresh DB read `streamOutcomeCard` takes right
 * before calling this, not the caller's tick-start snapshot: if `slack-reply`
 * commits between the eligibility check and this call, the full result has
 * already gone out by hand and this card must collapse rather than repeat it,
 * mirroring `outcomeContent`'s slackReplySent branch above.
 */
export async function childOutcomeContent(
  task: AgentTask,
  slackReplySent: boolean,
): Promise<string> {
  const agentName = await agentDisplayNameFor(task);
  if (task.status === "failed") {
    return `↳ ❌ ${agentName} — failed\n\n${outcomeText(task.failureReason, "Task failed.")}`;
  }
  if (slackReplySent) {
    return `↳ ✅ ${agentName} completed`;
  }
  return `↳ ✅ ${agentName} — result\n\n${outcomeText(task.output, "Task completed.")}`;
}

/**
 * True when `task` is a candidate for its own child result card (plan
 * section 3.4, rules 1-4, 3, and part of rule 6). Callers still need the
 * "no finalized outcome row" (rule 5), "slackReplySent" (rule 6) and
 * "flag on" (rule 7) checks, which need a DB read or the tick's flag state.
 */
function isChildCardCandidate(task: AgentTask, delegationActivatedAt: string): boolean {
  return (
    task.source !== "slack" &&
    !!task.slackChannelId &&
    !!task.slackThreadTs &&
    (task.status === "completed" || task.status === "failed") &&
    task.taskType !== "follow-up" &&
    task.taskType !== "reroute-decision" &&
    task.createdAt >= delegationActivatedAt
  );
}

function taskNeedsAskOutcome(task: AgentTask, activatedAt: string): boolean {
  return (
    task.source === "slack" && isAskOutcomeStatus(task.status) && task.createdAt >= activatedAt
  );
}

/**
 * One line per output-bearing closure member for the ask conclusion card's
 * "Results" section (plan section 3.4): a permalink line when the member has
 * its own finalized child card, otherwise a truncated digest line. Members
 * whose status never contributes output (running, superseded, lead
 * control-plane follow-up/reroute-decision tasks) are omitted — a superseded
 * task's resume child is itself a closure member and gets its own line.
 */
async function conclusionResultsLines(closure: AgentTask[]): Promise<string[]> {
  const lines: string[] = [];
  for (const member of closure) {
    if (member.taskType === "follow-up" || member.taskType === "reroute-decision") continue;
    if (!isOutcomeStatus(member.status)) continue;
    const glyph = await taskStateGlyph(member, new Date());
    const agentName = await agentDisplayNameFor(member);
    const card = await getSlackOutcomeMessage(member.id);
    if (card?.permalink) {
      lines.push(`↳ ${glyph} ${agentName} — ${card.permalink}`);
      continue;
    }
    const raw = outcomeText(member.status === "failed" ? member.failureReason : member.output, "");
    const digest =
      raw.length > CONCLUSION_DIGEST_LENGTH
        ? `${raw.slice(0, CONCLUSION_DIGEST_LENGTH).trimEnd()}…`
        : raw;
    const label = digest ? `${agentName} — ${digest}` : agentName;
    lines.push(`↳ ${glyph} ${label} ${getTaskLink(member.id)}`);
  }
  return lines;
}

/** One line per non-terminal closure member, for a timed-out conclusion card. */
async function conclusionTimeoutLines(ask: AgentTask, closure: AgentTask[]): Promise<string[]> {
  const lines: string[] = [];
  for (const member of [ask, ...closure]) {
    if (isTerminalTreeStatus(member.status)) continue;
    const glyph = await taskStateGlyph(member, new Date());
    lines.push(`↳ ${glyph} ${getTaskLink(member.id)}`);
  }
  return lines;
}

/**
 * The ask's deferred conclusion card content (plan section 3.4). A closure
 * with no delegated members reads identically to today's card; a timed-out
 * closure gets the unfinished-work header and the non-terminal member list.
 */
async function askConclusionContent(
  task: AgentTask,
  closure: AgentTask[],
  state: Extract<ClosureState, "settled" | "timedOut">,
  slackReplySent: boolean,
): Promise<string> {
  const body =
    state === "timedOut" && !isOutcomeStatus(task.status)
      ? "⏳ **Still in progress**"
      : await outcomeContent(task, slackReplySent);
  if (closure.length === 0 && state !== "timedOut") return body;

  const resultsLines = await conclusionResultsLines(closure);
  const sections = [body];
  if (resultsLines.length > 0) sections.push(`**Results**\n${resultsLines.join("\n")}`);
  if (state === "timedOut") {
    sections.unshift("⚠️ **Concluded with unfinished work**");
    const unfinishedLines = await conclusionTimeoutLines(task, closure);
    if (unfinishedLines.length > 0) sections.push(unfinishedLines.join("\n"));
  }
  return sections.join("\n\n");
}

/** Reaction gate mapping (plan section 3.5): a cancel is not a failure. */
function conclusionReactionOutcome(
  state: Extract<ClosureState, "settled" | "timedOut">,
  ask: AgentTask,
  closure: AgentTask[],
): "white_check_mark" | "x" | "warning" {
  if (state === "timedOut") return "warning";
  return [ask, ...closure].some((member) => member.status === "failed") ? "x" : "white_check_mark";
}

/** Observability signals from plan section 3.10, emitted after a successful finalize. */
async function recordSlackDelivery(
  task: AgentTask,
  outcome: SlackMessageRecord,
  kind: "child_outcome" | "conclusion" | "conclusion_timeout",
): Promise<void> {
  await createLogEntry({
    eventType: "slack_delivery",
    taskId: task.id,
    newValue: kind,
    metadata: {
      channelId: outcome.channelId,
      ts: outcome.ts,
      permalink: outcome.permalink,
    },
  });
  ensure({
    id: kind === "child_outcome" ? "slack.child-outcome.delivered" : "slack.conclusion.delivered",
    flow: "task",
    runId: task.id,
    data: {
      taskId: task.id,
      kind,
      channelId: outcome.channelId,
      permalink: outcome.permalink ?? null,
    },
  });
}

function attachmentLine(attachments: TaskAttachment[]): string | undefined {
  const attachment = attachments.find((item) => item.isPrimary) ?? attachments[0];
  if (!attachment) return undefined;
  const url = taskAttachmentDisplayUrl(attachment);
  return /^https?:\/\//.test(url) ? `📎 [${attachment.name}](${url})` : undefined;
}

type MarkdownFence = { character: "`" | "~"; length: number };

function fenceAt(line: string): MarkdownFence | undefined {
  const match = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
  if (!match) return undefined;
  const marker = match[1];
  if (!marker) return undefined;
  return { character: marker.startsWith("`") ? "`" : "~", length: marker.length };
}

function closesFence(line: string, fence: MarkdownFence): boolean {
  const pattern = fence.character === "`" ? "`" : "~";
  return new RegExp(`^[ \\t]{0,3}${pattern}{${fence.length},}[ \\t]*$`).test(line);
}

function safeMarkdownBoundary(markdown: string, maxLength: number): number {
  let fence: MarkdownFence | undefined;
  let lastLineBoundary = 0;
  let lastWordBoundary = 0;
  let offset = 0;

  for (const match of markdown.matchAll(/.*(?:\r?\n|$)/g)) {
    const rawLine = match[0];
    if (!rawLine) break;
    const line = rawLine.replace(/\r?\n$/, "");
    const lineEnd = offset + line.length;
    const wasInsideFence = !!fence;

    if (fence) {
      if (closesFence(line, fence)) fence = undefined;
    } else {
      fence = fenceAt(line);
    }

    if (!wasInsideFence && !fence) {
      for (const whitespace of line.matchAll(/\s+/g)) {
        const boundary = offset + (whitespace.index ?? 0);
        if (boundary <= maxLength) lastWordBoundary = boundary;
      }
    }
    if (!fence && lineEnd <= maxLength) lastLineBoundary = lineEnd;
    if (offset > maxLength) break;
    offset += rawLine.length;
  }

  return lastLineBoundary || lastWordBoundary;
}

function outcomePresentation(
  task: AgentTask,
  content: string,
  attachment: string | undefined,
): string {
  const body = normalizeV2Text([content, attachment].filter(Boolean).join("\n\n"));
  if (body.length <= MAX_OUTCOME_MARKDOWN_LENGTH) return body;

  const suffix = `\n\n… [View full task output](${getTaskUrl(task.id)})`;
  const boundary = safeMarkdownBoundary(body, MAX_OUTCOME_MARKDOWN_LENGTH - suffix.length);
  return `${body.slice(0, boundary).trimEnd()}${suffix}`;
}

function isStreamAlreadyStopped(error: unknown): boolean {
  const candidate = error as { data?: { error?: string } };
  return candidate.data?.error === "message_not_in_streaming_state";
}

async function slackTeamId(client: WebClient): Promise<string | undefined> {
  if (cachedTeamId) return cachedTeamId;
  const auth = await callSlackWithRetry(client, "auth.test", {});
  const teamId = auth.team_id;
  if (typeof teamId === "string" && teamId) cachedTeamId = teamId;
  return cachedTeamId;
}

async function outcomeFooter(
  task: AgentTask,
  tasks: AgentTask[],
  duration: string,
): Promise<unknown[]> {
  const descendants = buildAskClosure(task, tasks);
  const candidateAgentIds = [
    ...new Set(
      descendants.map((candidate) => candidate.agentId).filter((id): id is string => !!id),
    ),
  ];
  const candidateAgents = await Promise.all(candidateAgentIds.map((id) => getAgentById(id)));
  const nonLeadAgentIds = new Set(
    candidateAgentIds.filter((_, index) => !candidateAgents[index]?.isLead),
  );
  const workerIds = new Set(
    descendants
      .map((candidate) => candidate.agentId)
      .filter((agentId): agentId is string => !!agentId && nonLeadAgentIds.has(agentId)),
  );
  const who =
    workerIds.size > 0
      ? `${workerIds.size} worker${workerIds.size === 1 ? "" : "s"}`
      : task.agentId
        ? (await getAgentById(task.agentId))?.name
        : undefined;
  const parts = [duration, who, getTaskLink(task.id)].filter(Boolean);
  if (parts.length === 0) return [];
  return [{ type: "context", elements: [{ type: "mrkdwn", text: parts.join(" · ") }] }];
}

export async function streamOutcomeCard(
  task: AgentTask,
  tree: SlackMessageRecord,
  options?: {
    buildContent?: (task: AgentTask, slackReplySent: boolean) => Promise<string>;
    conclusionKind?: SlackConclusionKind;
  },
): Promise<SlackMessageRecord | null> {
  const app = getSlackApp();
  const allowInProgress = options?.conclusionKind === "timeout";
  if (
    !app ||
    !task.slackChannelId ||
    !task.slackThreadTs ||
    (!isOutcomeStatus(task.status) && !(allowInProgress && task.status === "in_progress"))
  )
    return null;
  const existing = await getSlackOutcomeMessage(task.id);
  if (existing?.finalizedAt) return existing;
  if (!tree.permalink) throw new Error(`Tree ${tree.id} has no permalink`);

  const tasks = await getSlackTasksInThread(task.slackChannelId, task.slackThreadTs);
  const duration = formatV2Duration(new Date(task.createdAt), terminalEnd(task, new Date()));
  const attachment = attachmentLine(await getTaskAttachments(task.id));
  // Re-read slackReplySent rather than trusting the caller's snapshot: it can flip
  // (via the slack-reply tool) between processSlackRenderV2's task fetch and the
  // Slack round trips in the outer render loop that run before this function is
  // called for the task.
  const slackReplySent = (await getTaskById(task.id))?.slackReplySent ?? task.slackReplySent;
  const content = await (options?.buildContent ?? outcomeContent)(task, slackReplySent);
  const presentation = outcomePresentation(task, content, attachment);
  if (!presentation) throw new Error(`Outcome presentation is empty for task ${task.id}`);

  const startPayload: Record<string, unknown> = {
    channel: task.slackChannelId,
    thread_ts: task.slackThreadTs,
    markdown_text: presentation,
  };
  const agent = task.agentId ? await getAgentById(task.agentId) : undefined;
  if (agent) {
    startPayload.username = getAgentDisplayName(agent);
    startPayload.icon_emoji = getAgentEmoji(agent);
  }
  if (!task.slackChannelId.startsWith("D") && task.slackUserId) {
    const teamId = await slackTeamId(app.client);
    if (teamId) {
      startPayload.recipient_user_id = task.slackUserId;
      startPayload.recipient_team_id = teamId;
    }
  }
  let outcome = existing;
  let reservationWasCreated = false;
  if (!outcome) {
    const reserved = await reserveSlackMessage({
      contextKey: task.contextKey ?? tree.contextKey,
      channelId: task.slackChannelId,
      threadTs: task.slackThreadTs,
      kind: "outcome",
      taskId: task.id,
    });
    outcome = reserved.record;
    reservationWasCreated = reserved.created;
  }
  let streamedFreshContent = false;
  if (isPendingSlackMessage(outcome)) {
    const reconciled = reservationWasCreated
      ? undefined
      : await findReservedSlackMessage(app.client, outcome, presentation);
    streamedFreshContent = !reconciled;
    const started =
      reconciled ?? (await callSlackWithRetry(app.client, "chat.startStream", startPayload));
    if (typeof started.ts !== "string" || !started.ts) {
      throw new Error("Slack did not return a timestamp for the outcome stream");
    }
    const persisted = await bindSlackMessageTimestamp(outcome.id, started.ts, {
      streamChunksAppended: 1,
    });
    if (!persisted) throw new Error("Failed to persist the outcome stream timestamp");
    outcome = persisted;
  }
  if (!streamedFreshContent) {
    // The stream backing this message was started (or reconciled from) an earlier
    // pass, whose slackReplySent snapshot may have since changed. Overwrite its
    // content with the freshly computed presentation before finalizing, so a
    // completed-then-collapsed reply doesn't finalize with stale full output.
    await callSlackWithRetry(app.client, "chat.update", {
      channel: task.slackChannelId,
      ts: outcome.ts,
      text: presentation,
    });
  }
  try {
    await callSlackWithRetry(app.client, "chat.stopStream", {
      channel: task.slackChannelId,
      ts: outcome.ts,
      blocks: await outcomeFooter(task, tasks, duration),
    });
  } catch (error) {
    // A process may have stopped the stream before it persisted the final
    // permalink. In that one recovery case the message is already immutable,
    // so continue by resolving and recording its permalink.
    if (!isStreamAlreadyStopped(error)) throw error;
  }
  const permalink = await resolvePermalink(app.client, task.slackChannelId, outcome.ts);
  return await updateSlackMessageRecord(outcome.id, {
    permalink,
    finalized: true,
    conclusionKind: options?.conclusionKind,
  });
}

export async function processSlackRenderV2(): Promise<void> {
  if (!isSlackRenderV2Enabled()) return;
  const activatedAt = await ensureSlackRenderV2Activation();
  const delegationEnabled = isSlackDelegationEnabled();
  const delegationActivatedAt = delegationEnabled ? await ensureSlackDelegationActivation() : null;

  for (const task of await getSlackTasksMissingTree()) {
    if (!isSlackRenderV2Enabled()) return;
    if (!task.slackChannelId || !task.slackThreadTs) continue;
    try {
      await ensureSlackThreadTree([task.id]);
    } catch (error) {
      console.error(`[Slack] Failed to create v2 tree for task ${task.id}:`, error);
    }
  }

  for (const storedTree of await getSlackTreeMessages()) {
    if (!isSlackRenderV2Enabled()) return;
    let tree = storedTree;
    const initialTasks = await getSlackTasksInThread(tree.channelId, tree.threadTs);
    if (isPendingSlackMessage(tree)) {
      try {
        const recovered = await ensureSlackThreadTree(initialTasks.map((task) => task.id));
        if (!recovered) continue;
        tree = recovered;
      } catch (error) {
        console.error(`[Slack] Failed to recover pending v2 tree ${tree.id}:`, error);
        continue;
      }
    }
    const app = getSlackApp();
    if (app && !tree.permalink) {
      try {
        tree = await ensureTreePermalink(app.client, tree);
      } catch (error) {
        if (isSlackMessageNotFound(error)) {
          try {
            await replaceMissingTree(tree);
          } catch (replacementError) {
            console.error(
              `[Slack] Failed to replace missing v2 tree ${tree.id}:`,
              replacementError,
            );
          }
          continue;
        }
        console.error(`[Slack] Failed to resolve v2 tree permalink ${tree.id}:`, error);
        continue;
      }
    }
    let tasks = await getSlackTasksInThread(tree.channelId, tree.threadTs);
    let needsOutcome = false;
    for (const task of tasks) {
      if ((await getSlackOutcomeMessage(task.id))?.finalizedAt) continue;
      // In-progress asks are eligible only for the timeout backstop. They do
      // not represent immediately active outcome work, so avoid waking an old
      // tree solely to verify its permalink on every render tick.
      const isAskCandidate = taskNeedsAskOutcome(task, activatedAt) && isOutcomeStatus(task.status);
      const isChildCandidate =
        delegationEnabled &&
        delegationActivatedAt !== null &&
        isChildCardCandidate(task, delegationActivatedAt) &&
        !task.slackReplySent;
      if (isAskCandidate || isChildCandidate) {
        needsOutcome = true;
        break;
      }
    }
    if (needsOutcome && app) {
      try {
        await resolvePermalink(app.client, tree.channelId, tree.ts);
      } catch (error) {
        if (!isSlackMessageNotFound(error)) {
          console.error(`[Slack] Failed to verify v2 tree ${tree.id}:`, error);
          continue;
        }
        try {
          const replacement = await replaceMissingTree(tree);
          if (!replacement) continue;
          tree = replacement;
          tasks = await getSlackTasksInThread(tree.channelId, tree.threadTs);
        } catch (replacementError) {
          console.error(`[Slack] Failed to replace missing v2 tree ${tree.id}:`, replacementError);
          continue;
        }
      }
    }
    const settleSec = Number(process.env.SLACK_CONCLUSION_SETTLE_SEC) || 10;
    const timeoutMin = Number(process.env.SLACK_CONCLUSION_TIMEOUT_MIN) || 240;
    const closuresByAskId = new Map<string, AgentTask[]>();
    const ownerAskId = new Map<string, string>();
    if (delegationEnabled) {
      for (const ask of tasks.filter((candidate) => candidate.source === "slack")) {
        const closure = buildAskClosure(ask, tasks);
        closuresByAskId.set(ask.id, closure);
        for (const member of closure) {
          if (!ownerAskId.has(member.id)) ownerAskId.set(member.id, ask.id);
        }
      }
    }
    const childCardCounts = new Map<string, number>();
    async function childCardCountFor(askId: string): Promise<number> {
      const cached = childCardCounts.get(askId);
      if (cached !== undefined) return cached;
      const closure = closuresByAskId.get(askId) ?? [];
      let count = 0;
      for (const member of closure) {
        if (await getSlackOutcomeMessage(member.id)) count++;
      }
      childCardCounts.set(askId, count);
      return count;
    }

    let outcomeCreated = false;
    // Child cards post before ask conclusions, in two passes over the same
    // tick. Tasks are walked in creation order, so an ask is otherwise
    // visited before the delegated children it owns; if their conclusion
    // ran first, a closure that goes fully terminal within one tick would
    // compute conclusionResultsLines() against children that have no card
    // yet, permanently fall back to digest text, and never self-correct —
    // the conclusion card is immutable once finalized.
    let childCardsThisTick = 0;
    for (const task of tasks) {
      if (!isSlackRenderV2Enabled()) return;
      if (task.source === "slack") continue;
      if ((await getSlackOutcomeMessage(task.id))?.finalizedAt) continue;
      if (!delegationEnabled || delegationActivatedAt === null) continue;
      if (!isChildCardCandidate(task, delegationActivatedAt) || task.slackReplySent) continue;
      const askId = ownerAskId.get(task.id);
      const ownerAsk = askId ? tasks.find((candidate) => candidate.id === askId) : undefined;
      if (!ownerAsk || ownerAsk.createdAt < delegationActivatedAt) continue;
      if (childCardsThisTick >= CHILD_CARDS_PER_TICK) continue;
      if (askId && (await childCardCountFor(askId)) >= CHILD_CARDS_PER_ASK) continue;
      try {
        const outcome = await streamOutcomeCard(task, tree, { buildContent: childOutcomeContent });
        if (outcome) {
          childCardsThisTick++;
          if (askId) childCardCounts.set(askId, (childCardCounts.get(askId) ?? 0) + 1);
          await recordSlackDelivery(task, outcome, "child_outcome");
        }
        outcomeCreated ||= !!outcome;
      } catch (error) {
        console.error(`[Slack] Failed to stream child outcome for task ${task.id}:`, error);
      }
    }

    for (const task of tasks) {
      if (!isSlackRenderV2Enabled()) return;
      if (task.source !== "slack") continue;
      if ((await getSlackOutcomeMessage(task.id))?.finalizedAt) continue;
      if (!isAskOutcomeStatus(task.status) || task.createdAt < activatedAt) continue;
      const deferByClosure =
        delegationEnabled &&
        delegationActivatedAt !== null &&
        task.createdAt >= delegationActivatedAt;

      if (!deferByClosure) {
        try {
          const outcome = await streamOutcomeCard(task, tree);
          if (outcome) await finalizeTerminalSlackReactions([task]);
          outcomeCreated ||= !!outcome;
        } catch (error) {
          console.error(`[Slack] Failed to stream outcome for task ${task.id}:`, error);
        }
        continue;
      }

      const closure = closuresByAskId.get(task.id) ?? buildAskClosure(task, tasks);
      // A conclusion is immutable, so wait until every eligible terminal
      // child has its card. The per-tick cap may leave overflow children
      // uncarded even though the closure itself is otherwise settled.
      let childCardPending = false;
      const existingChildCards = await childCardCountFor(task.id);
      for (const member of closure) {
        if (!isChildCardCandidate(member, delegationActivatedAt!) || member.slackReplySent)
          continue;
        // Once the per-ask cap is reached, remaining terminal children are
        // represented in the conclusion digest rather than blocking it.
        if (existingChildCards >= CHILD_CARDS_PER_ASK) break;
        if (!(await getSlackOutcomeMessage(member.id))?.finalizedAt) {
          childCardPending = true;
          break;
        }
      }
      if (childCardPending) continue;
      const state = closureState(task, closure, new Date(), settleSec, timeoutMin);
      if (state === "open") continue;
      try {
        const outcome = await streamOutcomeCard(task, tree, {
          buildContent: (_t, slackReplySent) =>
            askConclusionContent(task, closure, state, slackReplySent),
          conclusionKind: state === "timedOut" ? "timeout" : "complete",
        });
        if (outcome) {
          const app = getSlackApp();
          if (app && task.slackChannelId && task.slackTriggerMessageTs) {
            const reactionOutcome = conclusionReactionOutcome(state, task, closure);
            await finalizeSlackMessageReaction(
              app.client,
              task.slackChannelId,
              task.slackTriggerMessageTs,
              reactionOutcome,
            );
            await finalizeSlackSteerReactions([task], () => reactionOutcome);
          }
          await recordSlackDelivery(
            task,
            outcome,
            state === "timedOut" ? "conclusion_timeout" : "conclusion",
          );
        }
        outcomeCreated ||= !!outcome;
      } catch (error) {
        console.error(`[Slack] Failed to stream ask conclusion for task ${task.id}:`, error);
      }
    }
    try {
      await updateThreadTree(tree, outcomeCreated);
    } catch (error) {
      console.error(`[Slack] Failed to update v2 tree ${tree.id}:`, error);
    }
  }
}

export function _resetSlackRenderV2ForTests(): void {
  for (const timer of pendingTreeUpdates.values()) clearTimeout(timer);
  pendingTreeUpdates.clear();
  treeCreationPromises.clear();
  lastTreeText.clear();
  lastTreeUpdateAt.clear();
  treeUpdateTails.clear();
  cachedTeamId = undefined;
}
