import type { WebClient } from "@slack/web-api";
import {
  bindSlackMessageTimestamp,
  deleteSlackMessageRecord,
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
  type SlackMessageRecord,
  updateSlackMessageRecord,
} from "../be/db";
import { slackContextKey } from "../tasks/context-key";
import type { AgentTask, TaskAttachment } from "../types";
import { isEnvFlagEnabled } from "../utils/env-flag";
import { taskAttachmentDisplayUrl } from "../utils/task-attachment-links";
import { getSlackApp } from "./app";
import {
  getTaskLink,
  getTaskUrl,
  MAX_SECTION_LENGTH,
  markdownToSlack,
  splitSlackSectionText,
} from "./blocks";
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

function statusIcon(status: AgentTask["status"]): string {
  switch (status) {
    case "completed":
      return "✅";
    case "failed":
      return "❌";
    case "cancelled":
      return "🚫";
    case "superseded":
      return "↪️";
    default:
      return "⏳";
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

function renderNodeLabel(node: RenderNode, isAsk: boolean): string {
  if (isAsk) return markdownToSlack(cleanTaskDescription(node.task));
  return truncateTreeLabel(
    node.task.agentId ? (getAgentById(node.task.agentId)?.name ?? "Worker") : "Worker",
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

function renderNodeLines(node: RenderNode, depth: number, now: Date, isAsk: boolean): string[] {
  const duration = formatV2Duration(new Date(node.task.createdAt), terminalEnd(node.task, now));
  const indent = FIGURE_SPACE.repeat(
    TREE_INDENT.topLevel + Math.max(0, depth - 1) * TREE_INDENT.levelStep,
  );
  const boundedPrefix =
    indent.length > MAX_TREE_PREFIX_LENGTH
      ? `${indent.slice(0, MAX_TREE_PREFIX_LENGTH - 1)}…`
      : indent;
  let line = `${boundedPrefix}↳ ${statusIcon(node.task.status)} ${renderNodeLabel(node, isAsk)} · ${duration} · ${getTaskLink(node.task.id)}`;
  const progress = renderProgress(node.task.progress);
  const suffix = isTerminalTreeStatus(node.task.status) ? "" : progress ? ` · ${progress}` : "";
  if (suffix && line.length + suffix.length <= MAX_TREE_NODE_LINE_LENGTH) {
    line += suffix;
  }
  if (line.length > MAX_TREE_NODE_LINE_LENGTH) {
    line = `${line.slice(0, MAX_TREE_NODE_LINE_LENGTH - 1).trimEnd()}…`;
  }
  const lines = [line];
  node.children.forEach((child) => {
    lines.push(...renderNodeLines(child, depth + 1, now, false));
  });
  return lines;
}

function normalizeV2Text(value: string): string {
  return value.trim().replace(/\n{3,}/g, "\n\n");
}

export function renderThreadTree(
  tasks: AgentTask[],
  _outcomeLinks: ReadonlyMap<string, string> = new Map(),
  now = new Date(),
  _triggerLinks: ReadonlyMap<string, string> = new Map(),
): string {
  if (tasks.length === 0) return "🧵 worked for 0s";
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
  const lines = [`🧵 worked for ${threadDuration}`];
  const roots = buildRenderForest(tasks);
  roots.forEach((root) => {
    lines.push(...renderNodeLines(root, 1, now, root.task.source === "slack"));
  });
  const text = normalizeV2Text(lines.join("\n"));
  if (text.length <= MAX_SECTION_LENGTH) return text;

  const header = lines[0]!;
  const recentLines: string[] = [];
  for (let index = tasks.length - 1; index >= 0; index--) {
    const task = tasks[index]!;
    const recentLine = renderNodeLines({ task, children: [] }, 1, now, task.source === "slack")[0]!;
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
  return updateSlackMessageRecord(tree.id, { permalink, touchUpdatedAt: false }) ?? tree;
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

function discardTreeRecord(tree: SlackMessageRecord): void {
  const timer = pendingTreeUpdates.get(tree.id);
  if (timer) clearTimeout(timer);
  pendingTreeUpdates.delete(tree.id);
  lastTreeText.delete(tree.id);
  lastTreeUpdateAt.delete(tree.id);
  deleteSlackMessageRecord(tree.id);
}

function findThreadTree(
  contextKey: string,
  channelId: string,
  threadTs: string,
): SlackMessageRecord | null {
  return getSlackTreeMessage(contextKey) ?? getSlackTreeMessageByThread(channelId, threadTs);
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
  const existing = findThreadTree(contextKey, task.slackChannelId, task.slackThreadTs);
  if (existing && !isPendingSlackMessage(existing)) return existing;

  const renderedThrough = new Date().toISOString();
  const tasks = getSlackTasksInThread(task.slackChannelId, task.slackThreadTs);
  const agent = task.agentId ? getAgentById(task.agentId) : undefined;
  const text = renderThreadTree(tasks);
  const reserved = existing
    ? { record: existing, created: false }
    : reserveSlackMessage({
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
  let record = bindSlackMessageTimestamp(reservation.id, remote.ts, {
    renderedThrough,
  });
  if (!record) {
    record = getSlackTreeMessageByThread(task.slackChannelId, task.slackThreadTs);
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
  const task = taskIds.map(getTaskById).find((candidate): candidate is AgentTask => !!candidate);
  if (!task?.slackChannelId || !task.slackThreadTs) return null;
  const contextKey =
    task.contextKey ??
    slackContextKey({
      channelId: task.slackChannelId,
      threadTs: task.slackThreadTs,
    });
  const existing = findThreadTree(contextKey, task.slackChannelId, task.slackThreadTs);
  if (existing && !isPendingSlackMessage(existing)) {
    const app = getSlackApp();
    try {
      const resolved = app ? await ensureTreePermalink(app.client, existing) : existing;
      scheduleSlackTreeUpdate(resolved);
      return resolved;
    } catch (error) {
      if (!isSlackMessageNotFound(error)) throw error;
      discardTreeRecord(existing);
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
  discardTreeRecord(tree);
  const taskIds = getSlackTasksInThread(tree.channelId, tree.threadTs).map((task) => task.id);
  return taskIds.length > 0 ? ensureSlackThreadTree(taskIds) : null;
}

async function updateThreadTree(
  tree: SlackMessageRecord,
  bypassThrottle = false,
): Promise<boolean> {
  const result = await withTreeUpdateLock(tree.channelId, tree.threadTs, async () => {
    const app = getSlackApp();
    if (!app) return "unchanged" as const;
    const current = getSlackTreeMessageByThread(tree.channelId, tree.threadTs);
    if (!current || current.id !== tree.id) return "unchanged" as const;
    if (isPendingSlackMessage(current)) return "pending" as const;

    const renderedThrough = new Date().toISOString();
    const tasks = getSlackTasksInThread(current.channelId, current.threadTs);
    if (tasks.length === 0) return "unchanged" as const;
    const text = renderThreadTree(tasks);
    const lastText = lastTreeText.get(current.id);
    const lastUpdate = lastTreeUpdateAt.get(current.id) ?? 0;
    if (text === lastText) {
      markSlackTreeRendered(current.id, renderedThrough);
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
    markSlackTreeRendered(current.id, renderedThrough);
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

function outcomeText(value: string | null | undefined, fallback: string): string {
  return value?.trim() ? value : fallback;
}

function outcomeContent(task: AgentTask, slackReplySent: boolean): string {
  if (task.status === "failed") {
    return `❌ **Failed**\n\n${outcomeText(task.failureReason, "Task failed.")}`;
  }
  if (task.status === "cancelled") {
    return `🚫 **Cancelled**\n\n${outcomeText(task.failureReason, "Task was cancelled.")}`;
  }
  if (slackReplySent && task.status === "completed") {
    const agentName = task.agentId ? (getAgentById(task.agentId)?.name ?? "Agent") : "Agent";
    return `✅ ${agentName} completed`;
  }
  return `✅\n\n${outcomeText(task.output, "Task completed.")}`;
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

function outcomeFooter(task: AgentTask, tasks: AgentTask[], duration: string): unknown[] {
  const childrenByParent = new Map<string, AgentTask[]>();
  for (const candidate of tasks) {
    if (!candidate.parentTaskId) continue;
    const children = childrenByParent.get(candidate.parentTaskId) ?? [];
    children.push(candidate);
    childrenByParent.set(candidate.parentTaskId, children);
  }
  const descendants: AgentTask[] = [];
  const queue = [...(childrenByParent.get(task.id) ?? [])];
  while (queue.length > 0) {
    const candidate = queue.shift()!;
    // A later human ask may be parented to the previous ask for context
    // continuity, but it is a sibling in the Slack tree and owns its own card.
    if (candidate.source === "slack") continue;
    descendants.push(candidate);
    queue.push(...(childrenByParent.get(candidate.id) ?? []));
  }
  const workerIds = new Set(
    descendants
      .map((candidate) => candidate.agentId)
      .filter((agentId): agentId is string => !!agentId && !getAgentById(agentId)?.isLead),
  );
  const who =
    workerIds.size > 0
      ? `${workerIds.size} worker${workerIds.size === 1 ? "" : "s"}`
      : task.agentId
        ? getAgentById(task.agentId)?.name
        : undefined;
  const parts = [duration, who, getTaskLink(task.id)].filter(Boolean);
  if (parts.length === 0) return [];
  return [{ type: "context", elements: [{ type: "mrkdwn", text: parts.join(" · ") }] }];
}

export async function streamOutcomeCard(
  task: AgentTask,
  tree: SlackMessageRecord,
): Promise<SlackMessageRecord | null> {
  const app = getSlackApp();
  if (!app || !task.slackChannelId || !task.slackThreadTs || !isOutcomeStatus(task.status))
    return null;
  const existing = getSlackOutcomeMessage(task.id);
  if (existing?.finalizedAt) return existing;
  if (!tree.permalink) throw new Error(`Tree ${tree.id} has no permalink`);

  const tasks = getSlackTasksInThread(task.slackChannelId, task.slackThreadTs);
  const duration = formatV2Duration(new Date(task.createdAt), terminalEnd(task, new Date()));
  const attachment = attachmentLine(getTaskAttachments(task.id));
  // Re-read slackReplySent rather than trusting the caller's snapshot: it can flip
  // (via the slack-reply tool) between processSlackRenderV2's task fetch and the
  // Slack round trips in the outer render loop that run before this function is
  // called for the task.
  const slackReplySent = getTaskById(task.id)?.slackReplySent ?? task.slackReplySent;
  const content = outcomeContent(task, slackReplySent);
  const presentation = outcomePresentation(task, content, attachment);
  if (!presentation) throw new Error(`Outcome presentation is empty for task ${task.id}`);

  const startPayload: Record<string, unknown> = {
    channel: task.slackChannelId,
    thread_ts: task.slackThreadTs,
    markdown_text: presentation,
  };
  const agent = task.agentId ? getAgentById(task.agentId) : undefined;
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
    const reserved = reserveSlackMessage({
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
    const persisted = bindSlackMessageTimestamp(outcome.id, started.ts, {
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
      blocks: outcomeFooter(task, tasks, duration),
    });
  } catch (error) {
    // A process may have stopped the stream before it persisted the final
    // permalink. In that one recovery case the message is already immutable,
    // so continue by resolving and recording its permalink.
    if (!isStreamAlreadyStopped(error)) throw error;
  }
  const permalink = await resolvePermalink(app.client, task.slackChannelId, outcome.ts);
  return updateSlackMessageRecord(outcome.id, { permalink, finalized: true });
}

export async function processSlackRenderV2(): Promise<void> {
  if (!isSlackRenderV2Enabled()) return;
  const activatedAt = ensureSlackRenderV2Activation();

  for (const task of getSlackTasksMissingTree()) {
    if (!isSlackRenderV2Enabled()) return;
    if (!task.slackChannelId || !task.slackThreadTs) continue;
    try {
      await ensureSlackThreadTree([task.id]);
    } catch (error) {
      console.error(`[Slack] Failed to create v2 tree for task ${task.id}:`, error);
    }
  }

  for (const storedTree of getSlackTreeMessages()) {
    if (!isSlackRenderV2Enabled()) return;
    let tree = storedTree;
    const initialTasks = getSlackTasksInThread(tree.channelId, tree.threadTs);
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
    let tasks = getSlackTasksInThread(tree.channelId, tree.threadTs);
    const needsOutcome = tasks.some(
      (task) =>
        task.source === "slack" &&
        task.createdAt >= activatedAt &&
        isOutcomeStatus(task.status) &&
        !getSlackOutcomeMessage(task.id)?.finalizedAt,
    );
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
          tasks = getSlackTasksInThread(tree.channelId, tree.threadTs);
        } catch (replacementError) {
          console.error(`[Slack] Failed to replace missing v2 tree ${tree.id}:`, replacementError);
          continue;
        }
      }
    }
    let outcomeCreated = false;
    for (const task of tasks) {
      if (!isSlackRenderV2Enabled()) return;
      if (task.source !== "slack" || !isOutcomeStatus(task.status)) continue;
      if (task.createdAt < activatedAt) continue;
      if (getSlackOutcomeMessage(task.id)?.finalizedAt) continue;
      try {
        const outcome = await streamOutcomeCard(task, tree);
        outcomeCreated ||= !!outcome;
      } catch (error) {
        console.error(`[Slack] Failed to stream outcome for task ${task.id}:`, error);
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
