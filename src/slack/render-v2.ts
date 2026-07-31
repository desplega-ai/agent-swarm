import type { WebClient } from "@slack/web-api";
import {
  getAgentById,
  getInProgressSlackTasks,
  getSlackOutcomeMessage,
  getSlackTasksInThread,
  getSlackTreeMessage,
  getSlackTreeMessageByThread,
  getSlackTreeMessages,
  getTaskAttachments,
  getTaskById,
  recordSlackMessage,
  type SlackMessageRecord,
  updateSlackMessageRecord,
} from "../be/db";
import { slackContextKey } from "../tasks/context-key";
import type { AgentTask, TaskAttachment } from "../types";
import { isEnvFlagEnabled } from "../utils/env-flag";
import { taskAttachmentDisplayUrl } from "../utils/task-attachment-links";
import { getSlackApp } from "./app";
import { getTaskLink, markdownToSlack } from "./blocks";

const TREE_UPDATE_DEBOUNCE_MS = 500;
const TREE_UPDATE_MIN_INTERVAL_MS = 3_000;
const MAX_SLACK_RETRIES = 3;
const MAX_RETRY_DELAY_MS = 30_000;
const MAX_TITLE_LENGTH = 72;
const MAX_OUTCOME_SUMMARY_LENGTH = 600;

const treeCreationPromises = new Map<string, Promise<SlackMessageRecord | null>>();
const pendingTreeUpdates = new Map<string, ReturnType<typeof setTimeout>>();
const lastTreeText = new Map<string, string>();
const lastTreeUpdateAt = new Map<string, number>();
let cachedTeamId: string | undefined;

type SlackApiResult = Record<string, unknown> & { ok?: boolean; ts?: string; permalink?: string };

export function isSlackRenderV2Enabled(): boolean {
  return isEnvFlagEnabled("SLACK_RENDER_V2", true);
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
    case "cancelled":
    case "superseded":
      return "❌";
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
  const terminal = ["completed", "failed", "cancelled", "superseded"].includes(task.status);
  const end = terminal ? (task.finishedAt ?? task.lastUpdatedAt) : undefined;
  return end ? new Date(end) : now;
}

function cleanTaskDescription(task: AgentTask): string {
  if (task.title?.trim()) return task.title.trim();
  let text = task.task
    .replace(/<thread_context>[\s\S]*?<\/thread_context>/g, "")
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
  if (isAsk) return cleanTaskDescription(node.task);
  return node.task.agentId ? (getAgentById(node.task.agentId)?.name ?? "Worker") : "Worker";
}

function renderNodeLines(
  node: RenderNode,
  prefix: string,
  isLast: boolean,
  now: Date,
  outcomeLinks: ReadonlyMap<string, string>,
  isAsk: boolean,
): string[] {
  const connector = isLast ? "└─" : "├─";
  const duration = formatV2Duration(new Date(node.task.createdAt), terminalEnd(node.task, now));
  const result = outcomeLinks.get(node.task.id);
  let line = `${prefix}${connector} ${statusIcon(node.task.status)} ${renderNodeLabel(node, isAsk)} · ${duration} · ${getTaskLink(node.task.id)}`;
  if (result) line += ` → <${result}|result>`;
  const lines = [line];
  const childPrefix = `${prefix}${isLast ? "   " : "│  "}`;
  node.children.forEach((child, index) => {
    lines.push(
      ...renderNodeLines(
        child,
        childPrefix,
        index === node.children.length - 1,
        now,
        outcomeLinks,
        false,
      ),
    );
  });
  return lines;
}

export function renderThreadTree(
  tasks: AgentTask[],
  outcomeLinks: ReadonlyMap<string, string> = new Map(),
  now = new Date(),
): string {
  if (tasks.length === 0) return "🧵 *Task thread* · 0s";
  const asks = tasks.filter((task) => task.source === "slack");
  const first = asks[0] ?? tasks[0]!;
  const hasActiveTask = tasks.some(
    (task) => !["completed", "failed", "cancelled", "superseded"].includes(task.status),
  );
  const threadEnd = hasActiveTask
    ? now
    : tasks.reduce((latest, task) => {
        const end = terminalEnd(task, now);
        return end > latest ? end : latest;
      }, new Date(first.createdAt));
  const threadDuration = formatV2Duration(new Date(first.createdAt), threadEnd);
  const lines = [`🧵 *${cleanTaskDescription(first)}* · ${threadDuration}`];
  const roots = buildRenderForest(tasks);
  roots.forEach((root, index) => {
    lines.push(
      ...renderNodeLines(
        root,
        "",
        index === roots.length - 1,
        now,
        outcomeLinks,
        root.task.source === "slack",
      ),
    );
  });
  return lines.join("\n");
}

function treeBlocks(text: string): unknown[] {
  return [{ type: "section", text: { type: "mrkdwn", text } }];
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
  return updateSlackMessageRecord(tree.id, { permalink }) ?? tree;
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
  if (existing) return existing;

  const tasks = getSlackTasksInThread(task.slackChannelId, task.slackThreadTs);
  const text = renderThreadTree(tasks);
  const response = await callSlackWithRetry(app.client, "chat.postMessage", {
    channel: task.slackChannelId,
    thread_ts: task.slackThreadTs,
    text,
    blocks: treeBlocks(text),
  });
  if (typeof response.ts !== "string" || !response.ts) {
    throw new Error("Slack did not return a timestamp for the thread tree");
  }
  let record = recordSlackMessage({
    contextKey,
    channelId: task.slackChannelId,
    threadTs: task.slackThreadTs,
    ts: response.ts,
    kind: "tree",
    taskId: task.id,
  });
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
  if (existing) {
    const app = getSlackApp();
    const resolved = app ? await ensureTreePermalink(app.client, existing) : existing;
    scheduleSlackTreeUpdate(resolved);
    return resolved;
  }
  const inFlight = treeCreationPromises.get(contextKey);
  if (inFlight) return inFlight;
  const creation = createThreadTree(task).finally(() => treeCreationPromises.delete(contextKey));
  treeCreationPromises.set(contextKey, creation);
  return creation;
}

function scheduleSlackTreeUpdate(tree: SlackMessageRecord): void {
  const existing = pendingTreeUpdates.get(tree.id);
  if (existing) clearTimeout(existing);
  pendingTreeUpdates.set(
    tree.id,
    setTimeout(() => {
      pendingTreeUpdates.delete(tree.id);
      void updateThreadTree(tree, true).catch((error) => {
        console.error(`[Slack] Failed to run debounced v2 tree update ${tree.id}:`, error);
      });
    }, TREE_UPDATE_DEBOUNCE_MS),
  );
}

function outcomeLinksFor(tasks: AgentTask[]): Map<string, string> {
  const links = new Map<string, string>();
  for (const task of tasks) {
    const outcome = getSlackOutcomeMessage(task.id);
    if (outcome?.permalink && outcome.finalizedAt) links.set(task.id, outcome.permalink);
  }
  return links;
}

async function updateThreadTree(tree: SlackMessageRecord, force = false): Promise<boolean> {
  const app = getSlackApp();
  if (!app) return false;
  const tasks = getSlackTasksInThread(tree.channelId, tree.threadTs);
  if (tasks.length === 0) return false;
  const text = renderThreadTree(tasks, outcomeLinksFor(tasks));
  const lastText = lastTreeText.get(tree.id);
  const lastUpdate = lastTreeUpdateAt.get(tree.id) ?? 0;
  if (!force && text === lastText) return false;
  const remaining = TREE_UPDATE_MIN_INTERVAL_MS - (Date.now() - lastUpdate);
  if (remaining > 0) {
    scheduleSlackTreeUpdate(tree);
    return false;
  }
  await callSlackWithRetry(app.client, "chat.update", {
    channel: tree.channelId,
    ts: tree.ts,
    text,
    blocks: treeBlocks(text),
  });
  lastTreeText.set(tree.id, text);
  lastTreeUpdateAt.set(tree.id, Date.now());
  updateSlackMessageRecord(tree.id, {});
  return true;
}

function outcomeSummary(output: string | null | undefined): string {
  const normalized = markdownToSlack(output?.trim() || "Task completed.")
    .replace(/^#+\s*/gm, "")
    .replace(/\n{2,}[\s\S]*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= MAX_OUTCOME_SUMMARY_LENGTH) return normalized;
  const boundary = normalized.lastIndexOf(" ", MAX_OUTCOME_SUMMARY_LENGTH - 1);
  const cut = boundary > 300 ? boundary : MAX_OUTCOME_SUMMARY_LENGTH - 1;
  return `${normalized.slice(0, cut).trimEnd()}…`;
}

function attachmentLine(attachments: TaskAttachment[]): string | undefined {
  const attachment = attachments.find((item) => item.isPrimary) ?? attachments[0];
  if (!attachment) return undefined;
  const url = taskAttachmentDisplayUrl(attachment);
  return /^https?:\/\//.test(url) ? `📎 <${url}|${attachment.name}>` : undefined;
}

function presentationChunks(text: string, count = 3): string[] {
  if (text.length <= count) return [...text];
  const chunks: string[] = [];
  let cursor = 0;
  for (let index = 0; index < count - 1; index++) {
    const target = Math.ceil((text.length - cursor) / (count - index));
    let end = cursor + target;
    const nextSpace = text.indexOf(" ", end);
    if (nextSpace !== -1 && nextSpace - end < 40) end = nextSpace + 1;
    chunks.push(text.slice(cursor, end));
    cursor = end;
  }
  chunks.push(text.slice(cursor));
  return chunks.filter(Boolean);
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

function outcomeFooter(task: AgentTask, tasks: AgentTask[], treePermalink: string): unknown[] {
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
  const parts = [who, getTaskLink(task.id), `<${treePermalink}|↑ tree>`].filter(Boolean);
  if (parts.length === 0) return [];
  return [{ type: "context", elements: [{ type: "mrkdwn", text: parts.join(" · ") }] }];
}

export async function streamOutcomeCard(
  task: AgentTask,
  tree: SlackMessageRecord,
): Promise<SlackMessageRecord | null> {
  const app = getSlackApp();
  if (!app || !task.slackChannelId || !task.slackThreadTs || task.status !== "completed")
    return null;
  const existing = getSlackOutcomeMessage(task.id);
  if (existing?.finalizedAt) return existing;
  if (!tree.permalink) throw new Error(`Tree ${tree.id} has no permalink`);

  const tasks = getSlackTasksInThread(task.slackChannelId, task.slackThreadTs);
  const duration = formatV2Duration(new Date(task.createdAt), terminalEnd(task, new Date()));
  const attachment = attachmentLine(getTaskAttachments(task.id));
  const body = [
    `✅ *Done* · ${duration} · ${getTaskLink(task.id)}`,
    outcomeSummary(task.output),
    attachment,
  ]
    .filter(Boolean)
    .join("\n");

  const startPayload: Record<string, unknown> = {
    channel: task.slackChannelId,
    thread_ts: task.slackThreadTs,
  };
  if (!task.slackChannelId.startsWith("D") && task.slackUserId) {
    const teamId = await slackTeamId(app.client);
    if (teamId) {
      startPayload.recipient_user_id = task.slackUserId;
      startPayload.recipient_team_id = teamId;
    }
  }
  let outcome = existing;
  if (!outcome) {
    const started = await callSlackWithRetry(app.client, "chat.startStream", startPayload);
    if (typeof started.ts !== "string" || !started.ts) {
      throw new Error("Slack did not return a timestamp for the outcome stream");
    }
    outcome = recordSlackMessage({
      contextKey: task.contextKey ?? tree.contextKey,
      channelId: task.slackChannelId,
      threadTs: task.slackThreadTs,
      ts: started.ts,
      kind: "outcome",
      taskId: task.id,
    });
  }
  const chunks = presentationChunks(body);
  for (let index = outcome.streamChunksAppended; index < chunks.length; index++) {
    await callSlackWithRetry(app.client, "chat.appendStream", {
      channel: task.slackChannelId,
      ts: outcome.ts,
      markdown_text: chunks[index],
    });
    outcome = updateSlackMessageRecord(outcome.id, { streamChunksAppended: index + 1 }) ?? outcome;
  }
  try {
    await callSlackWithRetry(app.client, "chat.stopStream", {
      channel: task.slackChannelId,
      ts: outcome.ts,
      blocks: outcomeFooter(task, tasks, tree.permalink),
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
  for (const task of getInProgressSlackTasks()) {
    if (!task.slackChannelId || !task.slackThreadTs) continue;
    const contextKey =
      task.contextKey ??
      slackContextKey({ channelId: task.slackChannelId, threadTs: task.slackThreadTs });
    if (!findThreadTree(contextKey, task.slackChannelId, task.slackThreadTs)) {
      try {
        await ensureSlackThreadTree([task.id]);
      } catch (error) {
        console.error(`[Slack] Failed to create v2 tree for task ${task.id}:`, error);
      }
    }
  }

  for (const storedTree of getSlackTreeMessages()) {
    let tree = storedTree;
    const app = getSlackApp();
    if (app && !tree.permalink) {
      try {
        tree = await ensureTreePermalink(app.client, tree);
      } catch (error) {
        console.error(`[Slack] Failed to resolve v2 tree permalink ${tree.id}:`, error);
        continue;
      }
    }
    const tasks = getSlackTasksInThread(tree.channelId, tree.threadTs);
    let outcomeCreated = false;
    for (const task of tasks) {
      if (task.source !== "slack" || task.status !== "completed") continue;
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
  cachedTeamId = undefined;
}
