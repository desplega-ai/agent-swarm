import type { ContextSnapshot, SteeringMessage } from "@/api/types";
import type { ProviderMetaBlock, SubagentRun } from "@/logs-parser";
// Relative, so the root `bun test` resolves it (the `@/` alias is UI-only).
import { formatCost } from "../../lib/cost-format";

/**
 * The session log's row model and its two views.
 *
 * - Everything: the rows `buildStream` (session-log-viewer.tsx) makes from
 *   the parsed messages, one per event.
 * - Messages: `toMessageRows` keeps the messages and folds each run of tool,
 *   thinking and helper rows into one `activity` line. A run result becomes
 *   one `end` line, so the answer does not show a second time.
 */
export type SessionLogView = "messages" | "everything";

export type ToolKind = "mcp" | "bash" | "file" | "web" | "task" | "skill" | "other";

export interface ToolEntry {
  id: string;
  kind: ToolKind;
  name: string;
  server: string;
  title: string;
  detail: string;
  input: string;
  preview: string;
  body: string;
  ok: boolean;
  hasResult: boolean;
  durMs: number;
}

export type StreamRow =
  | { type: "compaction"; id: string; snapshot: ContextSnapshot }
  | {
      type: "steering";
      id: string;
      time: string;
      iso: string;
      message: SteeringMessage;
      isNew: boolean;
    }
  | {
      type: "agent";
      id: string;
      role: "assistant" | "user" | "system";
      time: string;
      iso: string;
      md: string;
      isNew: boolean;
    }
  | { type: "thinking"; id: string; time: string; iso: string; text: string; isNew: boolean }
  | {
      type: "meta";
      id: string;
      time: string;
      iso: string;
      block: ProviderMetaBlock;
      isNew: boolean;
    }
  | {
      type: "subagent";
      id: string;
      time: string;
      iso: string;
      run: SubagentRun;
      isNew: boolean;
    }
  | {
      type: "toolgroup";
      id: string;
      time: string;
      iso: string;
      tools: ToolEntry[];
      names: string[];
      durMs: number;
      defaultOpen: boolean;
      isNew: boolean;
    }
  | {
      /**
       * Messages view: one run of tool, thinking and helper rows. `rows` are
       * the original rows, which the line shows when it is open. The id and
       * `isNew` come from the first row, so the line keeps its id while a
       * live run grows.
       */
      type: "activity";
      id: string;
      time: string;
      iso: string;
      rows: StreamRow[];
      isNew: boolean;
    }
  | {
      /** Messages view: a run result, as one line. */
      type: "end";
      id: string;
      time: string;
      iso: string;
      isError: boolean;
      costUsd?: number;
      durationMs?: number;
      turns?: number;
      isNew: boolean;
    };

type FoldedRow = Extract<StreamRow, { type: "thinking" | "meta" | "toolgroup" }>;
type MetaRow = Extract<StreamRow, { type: "meta" }>;

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Human-friendly elapsed duration. 0/invalid → "" (renders nothing). */
export function formatDur(ms: number): string {
  if (!ms || ms < 0) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) {
    const s = ms / 1000;
    return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  }
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m${s ? ` ${s}s` : ""}`;
}

/** The result's cost, run time and turns, read the same way as the RESULT card. */
function toEndRow(row: MetaRow): StreamRow {
  const data = row.block.data;
  const cost = recordValue(data.cost);
  return {
    type: "end",
    id: `end-${row.id}`,
    time: row.time,
    iso: row.iso,
    isError: data.isError === true || data.is_error === true || cost.isError === true,
    costUsd: numberValue(cost.totalCostUsd) ?? numberValue(data.total_cost_usd),
    durationMs: numberValue(cost.durationMs) ?? numberValue(data.duration_ms),
    turns: numberValue(cost.numTurns) ?? numberValue(data.num_turns),
    isNew: row.isNew,
  };
}

/**
 * The Messages view of the Everything rows. Pure: the input rows are not
 * changed, and the same rows always give the same ids.
 *
 * - `agent`, `steering`, `subagent` and `compaction` rows stay as they are.
 * - Each run of other rows (tool groups, thinking, helper and runtime rows)
 *   becomes one `activity` row, `activity-<first row id>`.
 * - A `result` row becomes one `end` row, `end-<result row id>`.
 */
export function toMessageRows(rows: readonly StreamRow[]): StreamRow[] {
  const out: StreamRow[] = [];
  let run: FoldedRow[] = [];
  const closeRun = () => {
    const first = run[0];
    if (first) {
      out.push({
        type: "activity",
        id: `activity-${first.id}`,
        time: first.time,
        iso: first.iso,
        rows: run,
        isNew: first.isNew,
      });
    }
    run = [];
  };
  for (const row of rows) {
    if (row.type === "meta" && row.block.kind === "result") {
      closeRun();
      out.push(toEndRow(row));
    } else if (row.type === "toolgroup" || row.type === "thinking" || row.type === "meta") {
      run.push(row);
    } else {
      closeRun();
      out.push(row);
    }
  }
  closeRun();
  return out;
}

/**
 * Where a row of one view is in the other view's rows: the same row, the
 * activity line that folds it, or the end line of its result (and back from
 * those). -1 when the rows do not hold it, for example under a filter.
 */
export function matchingRowIndex(rows: readonly StreamRow[], id: string): number {
  const base = id.replace(/^(?:activity|end)-/, "");
  return rows.findIndex(
    (row) =>
      row.id === id ||
      row.id === base ||
      row.id === `end-${base}` ||
      (row.type === "activity" && row.rows.some((child) => child.id === base)),
  );
}

/** A one-line row label: a title, then stats joined with " · ". */
export interface RowSummary {
  title: string;
  stats: string[];
}

export function summaryText(summary: RowSummary): string {
  return [summary.title, ...summary.stats].join(" · ");
}

function thinkingGroupMs(row: FoldedRow): number {
  if (row.type !== "meta" || row.block.data.helperType !== "thinking_token_group") return 0;
  const first = Date.parse(String(row.block.data.firstIso));
  const last = Date.parse(String(row.block.data.lastIso));
  return Number.isFinite(first) && Number.isFinite(last) ? Math.max(0, last - first) : 0;
}

/**
 * An activity line: "Ran 3 tools · 4.2s · thought for 2s", "Thought for 2s",
 * or "2 events" for a run with no tool and no thinking. Thinking under 1 s
 * is left out. `names` are the tool names, in first-use order.
 */
export function summarizeActivity(
  row: Extract<StreamRow, { type: "activity" }>,
): RowSummary & { names: string[] } {
  let tools = 0;
  let toolMs = 0;
  let thinkingMs = 0;
  let thought = false;
  const names: string[] = [];
  for (const child of row.rows) {
    if (child.type === "toolgroup") {
      tools += child.tools.length;
      toolMs += child.durMs;
      for (const name of child.names) if (!names.includes(name)) names.push(name);
    } else if (child.type === "thinking") {
      thought = true;
    } else if (child.type === "meta" && child.block.data.helperType === "thinking_token_group") {
      thought = true;
      thinkingMs += thinkingGroupMs(child);
    }
  }
  const thinking = thinkingMs >= 1000 ? formatDur(thinkingMs) : "";
  if (tools > 0) {
    const stats = [formatDur(toolMs), thinking ? `thought for ${thinking}` : ""].filter(Boolean);
    return { title: `Ran ${tools} ${tools === 1 ? "tool" : "tools"}`, stats, names };
  }
  if (thought) return { title: thinking ? `Thought for ${thinking}` : "Thought", stats: [], names };
  const events = row.rows.length;
  return { title: `${events} ${events === 1 ? "event" : "events"}`, stats: [], names };
}

/** An end line: "Finished · $1.21 · 2m 56s · 26 turns", or "Ended with an error · …". */
export function summarizeEnd(row: Extract<StreamRow, { type: "end" }>): RowSummary {
  const stats: string[] = [];
  if (row.costUsd !== undefined) stats.push(formatCost(row.costUsd, { precision: 2 }));
  if (row.durationMs) stats.push(formatDur(row.durationMs));
  if (row.turns !== undefined) stats.push(`${row.turns} ${row.turns === 1 ? "turn" : "turns"}`);
  return { title: row.isError ? "Ended with an error" : "Finished", stats };
}
