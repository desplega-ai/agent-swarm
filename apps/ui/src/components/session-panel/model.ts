/**
 * Session panel — pure model. No React, no fetch, no app globals, so the panel
 * can be embedded outside the dashboard (swarm Apps) and unit-tested directly.
 *
 * Keys: the host picks a stable `pageKey` (`task:ui:{kind}:{ref}` in the
 * dashboard). Each session gets `contextKey = {pageKey}:{nonce}`, and the
 * dropdown lists sessions with `contextKeyPrefix = {pageKey}:`. The key is per
 * session on purpose: a page-level key would let server-side sibling awareness
 * nest a new session under one already running on the same page.
 */

export type SessionPanelTaskStatus =
  | "draft"
  | "backlog"
  | "unassigned"
  | "offered"
  | "reviewing"
  | "pending"
  | "in_progress"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "superseded";

/** The task fields the panel reads. A structural subset of the API's `AgentTask`. */
export interface SessionPanelTask {
  id: string;
  task: string;
  status: SessionPanelTaskStatus;
  createdAt: string;
  lastUpdatedAt?: string;
  parentTaskId?: string | null;
  requestedByUserId?: string | null;
  source?: string;
  taskType?: string;
  title?: string;
  taskPreview?: string;
  output?: string | null;
  failureReason?: string | null;
  progress?: string | null;
  isLeadTask?: boolean;
  agentName?: string;
}

export interface SessionPanelListItem {
  root: SessionPanelTask;
  lastActivityAt: string;
  latestStatus: SessionPanelTaskStatus;
  chainTaskCount: number;
}

/** `GET /api/sessions/{rootTaskId}`: the chain includes the root, ordered by `createdAt`. */
export interface SessionPanelDetail {
  root: SessionPanelTask;
  chain: SessionPanelTask[];
}

export const TERMINAL_STATUSES: ReadonlySet<SessionPanelTaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "superseded",
]);

export const ACTIVE_POLL_MS = 4000;
export const SETTLED_POLL_MS = 10_000;
export const LIST_POLL_MS = 15_000;

/** Prefix that matches every session under `pageKey`, and nothing under a longer key. */
export function contextKeyPrefix(pageKey: string): string {
  return `${pageKey}:`;
}

/** A new, per-session context key: exactly one extra part under the page key. */
export function newSessionContextKey(pageKey: string): string {
  return `${pageKey}:${crypto.randomUUID()}`;
}

const FOOTER_HEADING = "Page context";
const FOOTER_PATTERN = new RegExp(`\\n*---\\n${FOOTER_HEADING}(?: \\([^)\\n]*\\))?\\n[\\s\\S]*$`);

/**
 * Footer appended to the root task text only (follow-ups reach the lead
 * through the parent-chain preamble). It goes last so session titles and
 * previews still start with what the user typed.
 */
export function buildContextFooter(
  fields: ReadonlyArray<readonly [label: string, value: string | undefined]>,
  surface?: string,
): string {
  const lines = ["---", surface ? `${FOOTER_HEADING} (${surface})` : FOOTER_HEADING];
  for (const [label, value] of fields) {
    if (value) lines.push(`- ${label}: ${value}`);
  }
  return lines.join("\n");
}

export function withContextFooter(text: string, footer: string | undefined): string {
  return footer ? `${text}\n\n${footer}` : text;
}

/** The user's own words, without the footer the panel appended. */
export function stripContextFooter(text: string): string {
  return text.replace(FOOTER_PATTERN, "").trimEnd();
}

/** Dropdown label: custom title, else the first line of what the user typed. */
export function sessionLabel(root: SessionPanelTask, maxLength = 80): string {
  const raw = root.title?.trim() || stripContextFooter(root.taskPreview ?? root.task);
  const firstLine =
    raw
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? "";
  if (!firstLine) return "Untitled session";
  return firstLine.length > maxLength ? `${firstLine.slice(0, maxLength - 1)}…` : firstLine;
}

export function isChainSettled(chain: ReadonlyArray<{ status: SessionPanelTaskStatus }>): boolean {
  return chain.every((t) => TERMINAL_STATUSES.has(t.status));
}

/** Poll faster while any task in the chain is still moving. */
export function sessionPollMs(detail: SessionPanelDetail | null): number {
  if (!detail) return ACTIVE_POLL_MS;
  return isChainSettled([detail.root, ...detail.chain]) ? SETTLED_POLL_MS : ACTIVE_POLL_MS;
}

/** Newest task in the chain; follow-ups chain off it. */
export function latestLeaf(detail: SessionPanelDetail): SessionPanelTask {
  let latest = detail.root;
  for (const t of detail.chain) {
    if (t.createdAt.localeCompare(latest.createdAt) > 0) latest = t;
  }
  return latest;
}

/**
 * Where a follow-up goes. A running (or not yet started) lead leaf is steered,
 * so the message lands in the live session; anything else gets a child task.
 * Same rule as the dashboard's session composer.
 */
export function followUpTarget(
  detail: SessionPanelDetail,
  steeringSupported: boolean,
): { kind: "steer"; taskId: string } | { kind: "child"; parentTaskId: string } {
  const leaf = latestLeaf(detail);
  if (
    steeringSupported &&
    leaf.isLeadTask &&
    (leaf.status === "in_progress" || leaf.status === "pending")
  ) {
    return { kind: "steer", taskId: leaf.id };
  }
  return { kind: "child", parentTaskId: leaf.id };
}

export type TimelineEntry =
  | { kind: "user"; key: string; taskId: string; text: string; createdAt: string }
  | { kind: "agent"; key: string; task: SessionPanelTask; delegated: boolean };

/** System "review needed" nudges to the lead add nothing to a conversation. */
function isHiddenTask(task: SessionPanelTask): boolean {
  return task.source === "system" && task.taskType === "follow-up";
}

/**
 * Flatten a session into chat rows. A task someone typed (the root, or a
 * follow-up with `source: "ui"`) becomes a user bubble plus the agent's reply;
 * any other task is a delegated agent row. `requestedByUserId` alone is not a
 * signal: it propagates to every spawned child.
 */
export function timelineEntries(detail: SessionPanelDetail): TimelineEntry[] {
  const byId = new Map<string, SessionPanelTask>();
  for (const t of [detail.root, ...detail.chain]) byId.set(t.id, t);
  const tasks = [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const entries: TimelineEntry[] = [];
  for (const task of tasks) {
    if (isHiddenTask(task)) continue;
    const typed = task.id === detail.root.id || task.source === "ui";
    if (typed) {
      entries.push({
        kind: "user",
        key: `${task.id}:user`,
        taskId: task.id,
        text: stripContextFooter(task.task),
        createdAt: task.createdAt,
      });
    }
    entries.push({ kind: "agent", key: `${task.id}:agent`, task, delegated: !typed });
  }
  return entries;
}

export function statusLabel(status: SessionPanelTaskStatus): string {
  return status.replace("_", " ");
}
