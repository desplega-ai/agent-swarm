/**
 * The transcript's row model: one task's session log, its activity events and
 * its steering messages, merged in time order and folded into chat rows.
 *
 * The approach follows T3 Code's chat timeline
 * (https://github.com/pingdotgg/t3code, MIT License, Copyright (c) 2026 T3
 * Tools Inc.): the agent's prose is a row of its own, every run of tool
 * calls, reasoning and status events between two messages folds into one
 * "work" row with a one-line summary ("Read 3 files and ran 2 commands"), and
 * a finished turn folds behind a "Worked for 4m 12s" line that keeps only the
 * agent's last message in view.
 *
 * A task this one started is a row of its own at the time it was created,
 * linking to the child's own transcript: a delegation, a person's follow-up,
 * a deferral's wake-up, a resume, or the result sent to the lead
 * (`childKind`). A task started after the run ended comes after its outcome
 * (`rowsAfterEnd`).
 */

import type { AgentLog, AgentTask, SteeringMessage } from "@/api/types";
import type { ToolKind } from "@/components/shared/session-log-messages";
import { classifyTool } from "@/components/shared/session-log-viewer";
import { isAutoReview } from "@/lib/auto-review";
import { formatDuration, parseUTCDate } from "@/lib/utils";
import type { ParsedMessage, ToolResultBlock } from "@/logs-parser";

export type WorkEntry =
  | {
      kind: "tool";
      id: string;
      at: string;
      toolKind: ToolKind;
      /** The tool's own name (`Read`, `bash`, an MCP tool): the summary buckets on it. */
      name: string;
      title: string;
      detail: string;
      /** `running` while the call has no result yet. */
      status: "running" | "done" | "error";
      /** The call's raw input: the details panel formats it only when it opens. */
      input: unknown;
      /** The result's text, once the result arrives. */
      output?: string;
      /** From the call to its result, from the two log timestamps. */
      durationMs?: number;
    }
  | { kind: "thinking"; id: string; at: string; text: string }
  | { kind: "event"; id: string; at: string; text: string };

export type TranscriptRow =
  | { kind: "assistant"; id: string; at: string; text: string }
  | { kind: "steer"; id: string; at: string; message: SteeringMessage }
  | { kind: "child"; id: string; at: string; task: AgentTask; agentName: string | null }
  | { kind: "work"; id: string; at: string; entries: WorkEntry[] };

/** `t` is the sort time in ms: when the item entered the run. */
type Item =
  | { t: number; row: Exclude<TranscriptRow, { kind: "work" }> }
  | { t: number; entry: WorkEntry };

/** An activity event as one plain line, or null when it is noise at the task level. */
export function summarizeAgentLog(log: AgentLog): string | null {
  switch (log.eventType) {
    case "task_created":
      return "Created";
    case "task_offered":
      return "Offered to agent";
    case "task_accepted":
      return "Accepted";
    case "task_rejected":
      return "Rejected";
    case "task_claimed":
      return "Claimed";
    case "task_released":
      return "Released";
    case "task_status_change": {
      const old = log.oldValue ?? "";
      const next = log.newValue ?? "";
      if (!next) return null;
      return old ? `${old} → ${next}` : next;
    }
    case "task_progress": {
      const v = log.newValue?.trim();
      if (!v) return "Progress update";
      // Skip JSON envelopes: only plain prose progress notes read as a step.
      if (v.startsWith("{") || v.startsWith("[")) return null;
      return v.length > 140 ? `${v.slice(0, 140)}…` : v;
    }
    default:
      return null;
  }
}

/** SQLite timestamps carry no zone: `parseUTCDate` reads them as UTC, as the server writes them. */
function timeOf(at: string | undefined): number {
  if (!at) return 0;
  const t = parseUTCDate(at).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * The newest time among rows and the steps of their work rows, in ms (0 when
 * there are none). The transcript compares new data with it, never with the
 * browser's clock, which can be off from the server's.
 */
export function newestTime(items: (TranscriptRow | WorkEntry)[]): number {
  let newest = 0;
  for (const item of items) {
    newest = Math.max(newest, timeOf(item.at));
    if (item.kind === "work") newest = Math.max(newest, newestTime(item.entries));
  }
  return newest;
}

/**
 * Where a steering message sits in the run: a delivered one when the agent
 * got it, not when it was sent (a queued message waits for a turn boundary),
 * and a pending one after everything, since the agent has not seen it yet.
 */
function steerTime(message: SteeringMessage): number {
  if (message.status === "pending") return Number.POSITIVE_INFINITY;
  return timeOf(message.deliveredAt ?? message.createdAt);
}

/**
 * The main agent's tool calls, reasoning and (with `withMessages`) prose, in
 * log order. Sub-agent messages and the harness's user turns (the expanded
 * prompt, tool results) stay out: the raw log shows them. A tool result only
 * settles its call's status.
 */
function messageItems(parsed: ParsedMessage[], withMessages: boolean): Item[] {
  const results = new Map<string, { block: ToolResultBlock; t: number }>();
  for (const m of parsed) {
    for (const block of m.content) {
      if (block.type === "tool_result") {
        results.set(block.tool_use_id, { block, t: timeOf(m.timestamp) });
      }
    }
  }
  const out: Item[] = [];
  for (const m of parsed) {
    if (m.parentToolUseId) continue;
    m.content.forEach((block, idx) => {
      const id = `${m.id}-${idx}`;
      const at = m.timestamp;
      const t = timeOf(at);
      if (block.type === "tool_use") {
        const tool = classifyTool(block.name, block.input);
        const result = results.get(block.id);
        out.push({
          t,
          entry: {
            kind: "tool",
            id,
            at,
            toolKind: tool.kind,
            name: tool.name,
            title: tool.title,
            detail: tool.detail.trim(),
            status: !result ? "running" : result.block.isError ? "error" : "done",
            input: block.input,
            output: result?.block.content,
            durationMs: result && t > 0 && result.t >= t ? result.t - t : undefined,
          },
        });
      } else if (block.type === "thinking" && block.thinking.trim()) {
        out.push({ t, entry: { kind: "thinking", id, at, text: block.thinking.trim() } });
      } else if (
        withMessages &&
        m.role === "assistant" &&
        block.type === "text" &&
        block.text.trim()
      ) {
        out.push({ t, row: { kind: "assistant", id, at, text: block.text.trim() } });
      }
    });
  }
  return out;
}

export interface TranscriptSources {
  /** The parsed session log (`parseSessionLogs`). */
  messages: ParsedMessage[];
  /** The task's activity events (`task.logs`). */
  logs?: AgentLog[];
  steering?: SteeringMessage[];
  /** The tasks this one started (`directChildren`), each with its agent's name. */
  children?: { task: AgentTask; agentName: string | null }[];
  /** Keep the agent's prose as rows. Off: work and steering only (an inline activity feed). */
  withMessages?: boolean;
}

/**
 * Merges the sources by time (a stable sort: each source is already ordered,
 * the sort only interleaves them) and folds every run of work entries into
 * one work row. A message or a steering row ends the run.
 */
export function buildTranscriptRows({
  messages,
  logs = [],
  steering = [],
  children = [],
  withMessages = true,
}: TranscriptSources): TranscriptRow[] {
  const items = messageItems(messages, withMessages);
  for (const { task, agentName } of children) {
    items.push({
      t: timeOf(task.createdAt),
      row: { kind: "child", id: `child-${task.id}`, at: task.createdAt, task, agentName },
    });
  }
  for (const log of logs) {
    const text = summarizeAgentLog(log);
    if (text)
      items.push({
        t: timeOf(log.createdAt),
        entry: { kind: "event", id: log.id, at: log.createdAt, text },
      });
  }
  for (const message of steering) {
    const at = message.deliveredAt ?? message.createdAt;
    items.push({
      t: steerTime(message),
      row: { kind: "steer", id: `steer-${message.id}`, at, message },
    });
  }
  // Infinity - Infinity is NaN: two pending messages keep their own order.
  items.sort((a, b) => (a.t === b.t ? 0 : a.t - b.t));

  const rows: TranscriptRow[] = [];
  for (const item of items) {
    if ("row" in item) {
      rows.push(item.row);
      continue;
    }
    const last = rows[rows.length - 1];
    if (last?.kind === "work") {
      last.entries.push(item.entry);
    } else {
      rows.push({
        kind: "work",
        id: `work-${item.entry.id}`,
        at: item.entry.at,
        entries: [item.entry],
      });
    }
  }
  return rows;
}

/** Text compared as words: whitespace and surrounding blanks do not count. */
function sameText(a: string, b: string): boolean {
  const words = (text: string) => text.replace(/\s+/g, " ").trim();
  return words(a) === words(b);
}

/**
 * The rows a finished turn shows. Closed, the fold keeps only the agent's last
 * message in view (unless it says the same as `outcomeText`, the task's
 * outcome shown under the run), the tasks it started (each its own
 * transcript), and every steering message. Open,
 * every row shows in run order: work after the last message stays after it.
 */
export function foldedTurnRows(
  rows: TranscriptRow[],
  open: boolean,
  { outcomeText }: { outcomeText?: string } = {},
): TranscriptRow[] {
  if (open) return rows;
  let lastAssistant = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.kind === "assistant") {
      if (outcomeText === undefined || !sameText(row.text, outcomeText)) lastAssistant = i;
      break;
    }
  }
  return rows.filter(
    (row, i) => i === lastAssistant || row.kind === "child" || row.kind === "steer",
  );
}

/**
 * What a task this one started is. The server makes three kinds itself:
 * `resume` (the same work in a new session, after a shutdown or a crash),
 * `deferred` (the wake-up of a deferral, created when it fires) and the
 * system `follow-up` that sends a finished task's result to the lead
 * (`notify`). A task a person sent from the dashboard, Slack or a chat is
 * their follow-up message (`person`). Anything else an agent delegated.
 */
export type ChildKind = "delegation" | "person" | "deferred" | "resume" | "notify";

export function childKind(task: Pick<AgentTask, "taskType" | "source">): ChildKind {
  if (task.taskType === "resume") return "resume";
  if (task.taskType === "deferred") return "deferred";
  if (isAutoReview(task)) return "notify";
  if (task.source === "ui" || task.source === "slack" || task.source === "chat") return "person";
  return "delegation";
}

/**
 * Splits off the tasks started after the run ended (`endedAt`): a person's
 * follow-up, a wake-up, a resume. They come after the run's outcome, in time
 * order. Every other row stays in the run.
 */
export function rowsAfterEnd(
  rows: TranscriptRow[],
  endedAt: string | undefined,
): { during: TranscriptRow[]; after: TranscriptRow[] } {
  const end = endedAt ? timeOf(endedAt) : 0;
  if (!end) return { during: rows, after: [] };
  const during: TranscriptRow[] = [];
  const after: TranscriptRow[] = [];
  for (const row of rows)
    (row.kind === "child" && timeOf(row.at) >= end ? after : during).push(row);
  return { during, after };
}

/** A long transcript shows its newest rows first, this many per page. */
export const TRANSCRIPT_PAGE_ROWS = 200;

/** The newest `limit` rows, and how many older ones stay hidden. */
export function pagedRows(
  rows: TranscriptRow[],
  limit: number,
): { shown: TranscriptRow[]; hidden: number } {
  const hidden = Math.max(0, rows.length - limit);
  return { shown: hidden > 0 ? rows.slice(hidden) : rows, hidden };
}

/** The fold line: "Worked for 4m 12s", or "Activity" when the run has no end time. */
export function workedForLabel(start: string, end: string | undefined): string {
  const ms = end ? parseUTCDate(end).getTime() - parseUTCDate(start).getTime() : Number.NaN;
  return Number.isFinite(ms) && ms >= 0 ? `Worked for ${formatDuration(ms)}` : "Activity";
}

type Action = "read" | "edit" | "command" | "code-search" | "search" | "other" | "update";

const READ_TOOLS = new Set(["Read", "LS", "NotebookRead"]);
const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const CODE_SEARCH_TOOLS = new Set(["Glob", "Grep"]);

function actionOf(entry: WorkEntry): Action | null {
  if (entry.kind === "thinking") return null;
  if (entry.kind === "event") return "update";
  if (entry.toolKind === "bash") return "command";
  if (entry.toolKind === "web") return "search";
  if (entry.toolKind === "file") {
    if (READ_TOOLS.has(entry.name)) return "read";
    if (EDIT_TOOLS.has(entry.name)) return "edit";
    if (CODE_SEARCH_TOOLS.has(entry.name)) return "code-search";
  }
  return "other";
}

/** Commands and edits lead the summary; tools and updates come last. */
const ACTION_PRIORITY: Record<Action, number> = {
  command: 0,
  edit: 0,
  read: 1,
  "code-search": 1,
  search: 1,
  other: 2,
  update: 2,
};

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function actionLabel(action: Action, entries: WorkEntry[]): string {
  const n = entries.length;
  switch (action) {
    case "read":
      return `Read ${n} ${plural(n, "file", "files")}`;
    case "edit": {
      // Two edits to one file are one changed file.
      const files = new Set(entries.map((e) => (e.kind === "tool" ? e.detail : e.id))).size;
      return `Changed ${files} ${plural(files, "file", "files")}`;
    }
    case "command":
      return `Ran ${n} ${plural(n, "command", "commands")}`;
    case "code-search":
      return `Searched code ${n} ${plural(n, "time", "times")}`;
    case "search":
      return `Searched the web ${n} ${plural(n, "time", "times")}`;
    case "other":
      return `Used ${n} ${plural(n, "tool", "tools")}`;
    case "update":
      return `Received ${n} ${plural(n, "update", "updates")}`;
  }
}

/** "A", "A and b", "A, b, and c": every part after the first starts lowercase. */
function sentence(parts: string[]): string {
  const [first, ...rest] = parts;
  const tail = rest.map((p) => p.charAt(0).toLowerCase() + p.slice(1));
  if (tail.length === 0) return first ?? "";
  if (tail.length === 1) return `${first} and ${tail[0]}`;
  return `${[first, ...tail.slice(0, -1)].join(", ")}, and ${tail[tail.length - 1]}`;
}

/**
 * A work row's one-line summary: reasoning only reads "Thought (×N)",
 * anything else names its two leading kinds of action and counts the rest.
 */
export function summarizeWork(entries: WorkEntry[]): string {
  const buckets = new Map<Action, WorkEntry[]>();
  for (const entry of entries) {
    const action = actionOf(entry);
    if (!action) continue;
    const bucket = buckets.get(action);
    if (bucket) bucket.push(entry);
    else buckets.set(action, [entry]);
  }
  if (buckets.size === 0) {
    return entries.length > 1 ? `Thought (×${entries.length})` : "Thought";
  }
  // Map order is first appearance, and the sort is stable: ties keep it.
  const ranked = [...buckets.entries()].sort(
    (a, b) => ACTION_PRIORITY[a[0]] - ACTION_PRIORITY[b[0]],
  );
  const parts = ranked.slice(0, 2).map(([action, list]) => actionLabel(action, list));
  const others = ranked.slice(2).reduce((sum, [, list]) => sum + list.length, 0);
  if (others > 0) parts.push(`Performed ${others} other ${plural(others, "action", "actions")}`);
  return sentence(parts);
}

/** One entry as a plain line: its tooltip and the live line's text. */
export function entrySummary(entry: WorkEntry): string {
  switch (entry.kind) {
    case "event":
      return entry.text;
    case "tool":
      return entry.detail ? `${entry.title} ${entry.detail}` : entry.title;
    case "thinking":
      return "Thinking";
  }
}
