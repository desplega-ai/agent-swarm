import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getTranscript } from "../api.ts";
import { CrownIcon } from "../components/CrownIcon.tsx";
import {
  fmtCost,
  fmtDate,
  fmtDuration,
  fmtScore,
  fmtTokens,
  humanizeKey,
} from "../components/format.ts";
import { HarnessIcon } from "../components/HarnessIcon.tsx";
import { JsonView } from "../components/JsonView.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { Spinner } from "../components/Spinner.tsx";
import { CostBadge, StatusBadge, StatusScore } from "../components/StatusBadge.tsx";
import { Tooltip } from "../components/Tooltip.tsx";
import { usePoll } from "../hooks.ts";
import {
  itemsToParsedMessages,
  normalizeSessionLogs,
  type ParsedMessage,
  type ProviderMetaBlock,
  type SessionLogRecord,
  type ToolResultBlock,
  type ToolUseBlock,
} from "../logs-parser/index.ts";
import type { AttemptTaskJson, TokenTotalsJson } from "../types.ts";
import "./transcript.css";

const THINKING_COLLAPSE = 400;
/** Successful tool results clip earlier (item 8 — no walls of monospace). */
const RESULT_CLIP = 700;
const ERROR_RESULT_CLIP = 2_000;
const RAW_CLIP = 2_000;
/** v7.7 item 6: distance (px) from the scrollport bottom that still counts as "pinned". */
const FOLLOW_THRESHOLD = 48;

/**
 * v7.7 item 6: expand/collapse-all signal for tool outputs. Each ResultBody
 * applies the latest nonce once, then local per-item toggles take over again.
 * Nothing persists across reloads (by design — keep it simple).
 */
interface BulkSignal {
  mode: "expand" | "collapse";
  nonce: number;
}

const ResultBulkContext = createContext<BulkSignal>({ mode: "collapse", nonce: 0 });

/** Nearest scrollable ancestor — in practice .rd-tab-content (run-details.css). */
function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let cur = el?.parentElement ?? null; cur !== null; cur = cur.parentElement) {
    const oy = getComputedStyle(cur).overflowY;
    if (oy === "auto" || oy === "scroll") return cur;
  }
  return null;
}

interface MetaLine {
  key: string;
  block: ProviderMetaBlock;
}

type Entry =
  | { kind: "divider"; key: string; iteration: number }
  | { kind: "msg"; key: string; msg: ParsedMessage }
  | { kind: "metas"; key: string; lines: MetaLine[] }
  | { kind: "raw"; key: string; cli: string; content: string; iteration: number };

interface BuiltTranscript {
  entries: Entry[];
  messageCount: number;
  /** Rows that contributed nothing to a parsed message — rendered as raw fallbacks. */
  unparsedCount: number;
  resultById: Map<string, ToolResultBlock>;
  callIds: Set<string>;
}

/**
 * Item 15 — render ALL rows. Every source row either contributes to a parsed
 * message (text/tool/meta blocks) or renders in place as a `.t-raw` fallback;
 * nothing is silently dropped.
 */
function buildTranscript(rows: SessionLogRecord[]): BuiltTranscript {
  const result = normalizeSessionLogs(rows);

  // Rows that failed JSONL decode render as raw text, not buried meta lines.
  const rawRecIds = new Set<string>();
  const items = result.items.filter((item) => {
    if (item.kind !== "parse_error") return true;
    rawRecIds.add(item.recId);
    return false;
  });
  const messages = itemsToParsedMessages(items);

  // Coverage: source rows that produced at least one content block.
  const covered = new Set<string>();
  for (const item of items) {
    if (item.kind === "tool_call" && !item.tool) continue;
    if (item.kind === "tool_result" && !item.result) continue;
    covered.add(item.recId);
    for (const id of item.coveredRecIds ?? []) covered.add(id);
  }

  const messagesByRec = new Map<string, ParsedMessage[]>();
  for (const msg of messages) {
    const list = messagesByRec.get(msg.id);
    if (list) list.push(msg);
    else messagesByRec.set(msg.id, [msg]);
  }

  // Pair tool results to their calls across ALL messages by tool_use_id.
  const resultById = new Map<string, ToolResultBlock>();
  const callIds = new Set<string>();
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === "tool_result") resultById.set(block.tool_use_id, block);
      else if (block.type === "tool_use") callIds.add(block.id);
    }
  }

  // Interleave: messages render at their first source row; uncovered rows
  // become raw entries in their original position.
  type SeqNode =
    | { kind: "msg"; msg: ParsedMessage }
    | { kind: "raw"; key: string; cli: string; content: string; iteration: number };
  const sequence: SeqNode[] = [];
  const emitted = new Set<string>();
  let unparsedCount = 0;
  result.ordered.forEach((d, i) => {
    const rec = d.rec;
    if (!rawRecIds.has(rec.id)) {
      const msgs = messagesByRec.get(rec.id);
      if (msgs && !emitted.has(rec.id)) {
        emitted.add(rec.id);
        for (const msg of msgs) sequence.push({ kind: "msg", msg });
        return;
      }
      if (covered.has(rec.id)) return;
    }
    unparsedCount++;
    sequence.push({
      kind: "raw",
      key: `raw-${i}`,
      cli: rec.cli,
      content: rec.content,
      iteration: rec.iteration,
    });
  });

  // Iteration dividers + collapsing of consecutive meta-only messages.
  const entries: Entry[] = [];
  let prevIteration: number | null = null;
  sequence.forEach((node, i) => {
    const iteration = node.kind === "msg" ? node.msg.iteration : node.iteration;
    const crossed = prevIteration !== null && iteration !== prevIteration;
    if (crossed) entries.push({ kind: "divider", key: `div-${i}`, iteration });
    prevIteration = iteration;

    if (node.kind === "raw") {
      entries.push(node);
      return;
    }
    const msg = node.msg;
    const metas = msg.content.filter((b): b is ProviderMetaBlock => b.type === "provider_meta");
    if (metas.length > 0 && metas.length === msg.content.length) {
      // meta-only message — consecutive ones collapse into one group
      const lines = metas.map((block, j) => ({ key: `m-${i}-${j}`, block }));
      const last = entries[entries.length - 1];
      if (last && last.kind === "metas") last.lines.push(...lines);
      else entries.push({ kind: "metas", key: `metas-${i}`, lines });
    } else {
      entries.push({ kind: "msg", key: `msg-${i}`, msg });
    }
  });

  return { entries, messageCount: messages.length, unparsedCount, resultById, callIds };
}

/** Per-task status/skip info for the §1 sub-tab glyphs (from tasks.json). */
export interface TranscriptTaskStatus {
  status: string | null;
  skipped: boolean;
}

/**
 * v7.7 item 7: attempt totals behind the All pill. costUsd is the attempt's
 * RECOMPUTE-PRICED total — it may exceed Σ harness-reported task costs.
 */
export interface TranscriptTotals {
  costUsd: number | null;
  durationMs: number | null;
  tokens: TokenTotalsJson | null;
}

export interface TranscriptOutcome {
  status: string;
  score: number | null;
  judgments: {
    kind: "llm" | "deterministic";
    name: string;
    pass: boolean;
    score: number | null;
    reasoning: string | null;
    dimension: string | null;
  }[];
}

/**
 * Round-10 item 2: one resolved executing member, keyed by agentId — the
 * client-side join of AttemptTaskJson.agentId ↔ the roster (attempt.workers),
 * with the v2 sandbox blob as fallback. UI-local by frozen contract (NOT an
 * API payload mirror — ui/src/types.ts stays untouched); RunDetailsPage
 * computes the lookup and threads it here.
 */
export interface TaskMemberInfo {
  agentId: string;
  /** Roster name ?? "Lead" / workerLabel(index, workerCount). */
  name: string;
  isLead: boolean;
  memberRole: "lead" | "worker";
  index: number;
  /** Harness-icon provider — roster provider ?? catalog provider of the effective config. */
  provider: string | null;
  /** Effective config id (member override ?? cell config). */
  configId: string | null;
  model: string | null;
  /** True when the member overrode the cell config (v7 §12.3 marker). */
  overridden: boolean;
  /** Agent status at roster capture; null on the sandbox fallback. */
  status: string | null;
}

/** agentId → member resolution; null agentId / no lookup / no match ⇒ null (render nothing). */
function memberOf(
  rec: AttemptTaskJson | null | undefined,
  members: Record<string, TaskMemberInfo> | null | undefined,
): TaskMemberInfo | null {
  if (rec === null || rec === undefined || rec.agentId === null) return null;
  return members?.[rec.agentId] ?? null;
}

/** Member detail hover card (round-10 item 2): name, role, config/model, provider, status. */
function TaskMemberCard(props: { member: TaskMemberInfo }): ReactNode {
  const m = props.member;
  return (
    <div className="tip-card">
      <div className="tip-card-title tm-card-title">
        {m.isLead ? <CrownIcon size={12} className="tm-crown" /> : null}
        <HarnessIcon harness={m.provider} size={12} plain />
        {m.name}
      </div>
      <ChipCardRow label="Role">{m.memberRole}</ChipCardRow>
      <ChipCardRow label="Config">
        {m.configId !== null ? <code>{m.configId}</code> : "—"}
        {m.overridden ? <span className="tm-override"> · override</span> : null}
      </ChipCardRow>
      <ChipCardRow label="Model">{m.model ?? "—"}</ChipCardRow>
      <ChipCardRow label="Provider">{m.provider ?? "—"}</ChipCardRow>
      <ChipCardRow label="Status">{m.status ?? "—"}</ChipCardRow>
      <ChipCardRow label="Agent">
        <code>{m.agentId}</code>
      </ChipCardRow>
    </div>
  );
}

/**
 * Round-10 item 2: compact "who ran this task" chip — crown (lead only) +
 * harness icon + member name; hover = the member detail card. Shared by the
 * left-bar task rows (RunDetailsPage) and the sub-tab outcome header.
 */
export function TaskMemberChip(props: { member: TaskMemberInfo }): ReactNode {
  const m = props.member;
  return (
    <Tooltip wide text={<TaskMemberCard member={m} />}>
      <span className="tm-chip">
        {m.isLead ? <CrownIcon size={12} className="tm-crown" /> : null}
        <HarnessIcon harness={m.provider} size={11} plain />
        <span className="tm-name">{m.name}</span>
      </span>
    </Tooltip>
  );
}

export default function Transcript(props: {
  attemptId: string;
  live?: boolean;
  /** v7 §1: attempt.taskIds in creation order — fixes sub-tab order + labels. */
  taskIds?: string[];
  /** v7 §1: taskId → display title (from the tasks.json artifact when loaded). */
  taskTitles?: Record<string, string>;
  /** v7 §1: taskId → status/skip info — drives the sub-tab status glyphs. */
  taskStatuses?: Record<string, TranscriptTaskStatus>;
  /**
   * v7.5 items 2/6: taskId → full per-task record (GET /api/attempts/:id/tasks)
   * — drives the selected sub-tab's header (status chip, outcome/error clamp,
   * per-task cost). Optional/additive: absent ⇒ no header (pre-v7.5 behavior).
   */
  taskRecords?: Record<string, AttemptTaskJson> | null;
  /**
   * v7.7 item 7: attempt totals for the All pill's inline metrics + hover.
   * Null/absent (older callers) ⇒ the All pill renders exactly as before.
   */
  totals?: TranscriptTotals | null;
  /** Attempt-level final result shown before transcript events. */
  outcome?: TranscriptOutcome | null;
  /**
   * Round-10 item 2: agentId → executing-member attribution (computed by
   * RunDetailsPage from the roster / sandbox blob). Optional/additive:
   * absent, or no agentId match ⇒ no attribution UI (v1-era unchanged).
   */
  members?: Record<string, TaskMemberInfo> | null;
  /** v7 §10.3: Workers-panel task chips focus a sub-tab (nonce re-triggers). */
  focusTask?: { taskId: string; nonce: number } | null;
}): ReactNode {
  const live = props.live === true;
  const { data, error } = usePoll(
    () => getTranscript(props.attemptId, { live }),
    live ? 5000 : null,
    [props.attemptId, live],
  );

  const rows = data?.source === "raw-session-logs" ? (data.rows ?? null) : null;

  // §1 frozen rule: sub-tabs render only when the rows span > 1 distinct
  // non-empty taskId. Tab set = props.taskIds ∪ row taskIds (tasks without any
  // rows — e.g. skipped dependents — keep a visible tab); order = props.taskIds
  // first, then first appearance in rows.
  const taskTabs = useMemo<string[] | null>(() => {
    if (rows === null) return null;
    const inRows: string[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      if (r.taskId !== "" && !seen.has(r.taskId)) {
        seen.add(r.taskId);
        inRows.push(r.taskId);
      }
    }
    if (seen.size < 2) return null;
    const ordered: string[] = [];
    for (const id of [...(props.taskIds ?? []), ...inRows]) {
      if (id !== "" && !ordered.includes(id)) ordered.push(id);
    }
    return ordered;
  }, [rows, props.taskIds]);

  // null = "All" (default). A selection whose tab disappears falls back to All;
  // the selection itself persists across live polls (component state).
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const activeTask =
    selectedTask !== null && taskTabs !== null && taskTabs.includes(selectedTask)
      ? selectedTask
      : null;

  // v7.5 items 2/6: the full record behind the selected sub-tab — drives the
  // header below the sticky bar. Absent records (taskRecords null/undefined,
  // e.g. older servers or v1-era attempts) ⇒ no header (pre-v7.5 behavior).
  const activeRecord = activeTask !== null ? (props.taskRecords?.[activeTask] ?? null) : null;

  // Focus requests from the Workers panel — each nonce applies at most once
  // (the page scopes focusTask to the current attempt, so 0 is a safe baseline).
  const appliedFocus = useRef(0);
  useEffect(() => {
    const f = props.focusTask;
    if (!f || f.nonce === appliedFocus.current) return;
    if (taskTabs?.includes(f.taskId) === true) {
      appliedFocus.current = f.nonce;
      setSelectedTask(f.taskId);
    }
  }, [props.focusTask, taskTabs]);

  // §1: filtering is client-side and reapplied on every poll; rows with an
  // empty taskId (synthesized fallback rows) appear ONLY under All.
  const visibleRows = useMemo(
    () =>
      rows !== null && activeTask !== null ? rows.filter((r) => r.taskId === activeTask) : rows,
    [rows, activeTask],
  );

  const built = useMemo(
    () => (visibleRows !== null ? buildTranscript(visibleRows) : null),
    [visibleRows],
  );

  // v7.7 item 6: expand/collapse-all for tool outputs (see ResultBulkContext).
  const [bulk, setBulk] = useState<BulkSignal>({ mode: "collapse", nonce: 0 });

  const hasBar = data?.source === "raw-session-logs";
  const rowCount = visibleRows?.length ?? 0;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);

  // v7.7 item 8: the sticky outcome block pins flush under the sticky bar,
  // whose height varies (pill wrap, unparsed badge) — measure it into
  // --tr-bar-h on the transcript root so CSS can use it as the sticky top.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-attach when the raw branch (and thus the bar ref) renders
  useLayoutEffect(() => {
    const root = rootRef.current;
    const bar = barRef.current;
    if (root === null || bar === null) return undefined;
    const apply = () => {
      root.style.setProperty("--tr-bar-h", `${String(bar.offsetHeight)}px`);
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [hasBar]);

  // ---- v7.7 item 6: live auto-scroll ----
  // While live, stay pinned to the scrollport bottom as rows stream in; a user
  // scroll-up disengages, the floating Follow button (or scrolling back down)
  // re-engages. followRef mirrors the state for the scroll handler.
  const followRef = useRef(true);
  const [follow, setFollow] = useState(true);
  const seenRows = useRef(0);
  const [newRows, setNewRows] = useState(0);
  const prevTask = useRef<string | null>(null);

  useEffect(() => {
    if (!live || !hasBar) return undefined;
    const sc = findScrollParent(rootRef.current);
    if (sc === null) return undefined;
    const onScroll = () => {
      const near = sc.scrollHeight - sc.scrollTop - sc.clientHeight < FOLLOW_THRESHOLD;
      if (near !== followRef.current) {
        followRef.current = near;
        setFollow(near);
      }
    };
    sc.addEventListener("scroll", onScroll, { passive: true });
    return () => sc.removeEventListener("scroll", onScroll);
  }, [live, hasBar]);

  // Pin BEFORE paint (useLayoutEffect) so appends never flash off-bottom.
  useLayoutEffect(() => {
    if (!live || !hasBar) return;
    const taskChanged = prevTask.current !== activeTask;
    prevTask.current = activeTask;
    if (followRef.current) {
      const sc = findScrollParent(rootRef.current);
      if (sc !== null) sc.scrollTop = sc.scrollHeight;
      seenRows.current = rowCount;
      setNewRows(0);
    } else if (taskChanged) {
      // a tab switch resets the "new rows since disengage" baseline
      seenRows.current = rowCount;
      setNewRows(0);
    } else {
      setNewRows(Math.max(0, rowCount - seenRows.current));
    }
  }, [live, hasBar, rowCount, activeTask]);

  const engageFollow = () => {
    followRef.current = true;
    setFollow(true);
    const sc = findScrollParent(rootRef.current);
    if (sc !== null) sc.scrollTop = sc.scrollHeight;
    seenRows.current = rowCount;
    setNewRows(0);
  };

  if (!data) {
    return (
      <div className="transcript">
        {error ? (
          <div className="t-empty dim">Transcript failed to load: {error}</div>
        ) : (
          <div className="t-empty">
            <Spinner label="Loading transcript…" />
          </div>
        )}
      </div>
    );
  }

  if (data.source === null) {
    return (
      <div className="transcript">
        <div className="t-empty dim">No transcript captured</div>
        {live ? <Footer /> : null}
      </div>
    );
  }

  if (data.source === "transcript") {
    return (
      <div className="transcript">
        <Caption harness={data.harness} live={false}>
          <span className="t-caption-sep">·</span>
          <span>Legacy flat transcript (older run)</span>
        </Caption>
        <pre className="t-flat">{data.text ?? ""}</pre>
        {live ? <Footer /> : null}
      </div>
    );
  }

  return (
    <div className="transcript" ref={rootRef}>
      {/* v7.5 item 4 + v7.7 item 7: ONE sticky row — caption (Live pulse) left,
          task pills right, expand-all at the far end — pinned to the top of the
          .rd-tab-content scrollport while the transcript scrolls. */}
      <div className={taskTabs !== null ? "tr-stickybar has-tabs" : "tr-stickybar"} ref={barRef}>
        <Caption harness={data.harness} live={data.live === true}>
          <span className="t-caption-sep">·</span>
          <span>{rowCount.toLocaleString()} Events</span>
          <span className="t-caption-sep">·</span>
          <span>{(built?.messageCount ?? 0).toLocaleString()} Messages</span>
          {built && built.unparsedCount > 0 ? (
            <>
              <span className="t-caption-sep">·</span>
              <Tooltip text="Rows the parser could not decode — rendered below as raw text">
                <span className="t-unparsed">{built.unparsedCount.toLocaleString()} Unparsed</span>
              </Tooltip>
            </>
          ) : null}
        </Caption>
        {taskTabs !== null ? (
          <TaskTabs
            tabs={taskTabs}
            active={activeTask}
            titles={props.taskTitles}
            statuses={props.taskStatuses}
            records={props.taskRecords}
            totals={props.totals}
            members={props.members}
            onSelect={setSelectedTask}
          />
        ) : null}
        {rowCount > 0 ? (
          <button
            type="button"
            className="t-toggle t-bulk"
            title={
              bulk.mode === "expand"
                ? "Collapse every tool output/result"
                : "Expand every tool output/result"
            }
            onClick={() =>
              setBulk((b) => ({
                mode: b.mode === "expand" ? "collapse" : "expand",
                nonce: b.nonce + 1,
              }))
            }
          >
            {bulk.mode === "expand" ? "⊟ Collapse Outputs" : "⊞ Expand Outputs"}
          </button>
        ) : null}
      </div>
      {/* keyed by task so the item-8 collapse state resets per sub-tab */}
      {activeRecord !== null ? (
        <TaskTabHeader
          rec={activeRecord}
          member={memberOf(activeRecord, props.members)}
          key={activeTask}
        />
      ) : null}
      <AttemptOutcomeCard outcome={props.outcome ?? null} />
      {rowCount === 0 ? (
        <div className="t-empty dim">
          {activeTask === null
            ? "No events yet"
            : resolveTaskStatus(activeTask, props.taskRecords, props.taskStatuses)?.skipped === true
              ? "No events for this task — it was skipped (failed dependency)"
              : "No events for this task"}
        </div>
      ) : null}
      <ResultBulkContext.Provider value={bulk}>
        {built?.entries.map((entry) => {
          switch (entry.kind) {
            case "divider": {
              return (
                <div className="t-divider" key={entry.key}>
                  — Iteration {entry.iteration} —
                </div>
              );
            }
            case "metas": {
              return <MetaGroup lines={entry.lines} key={entry.key} />;
            }
            case "raw": {
              return <RawRow cli={entry.cli} content={entry.content} key={entry.key} />;
            }
            default: {
              return (
                <MessageCard
                  msg={entry.msg}
                  resultById={built.resultById}
                  callIds={built.callIds}
                  key={entry.key}
                />
              );
            }
          }
        })}
      </ResultBulkContext.Provider>
      {live ? <Footer /> : null}
      {live && !follow ? (
        <div className="t-follow-wrap">
          <button
            type="button"
            className="t-follow"
            onClick={engageFollow}
            title={
              newRows > 0
                ? `Resume auto-scroll · ${newRows.toLocaleString()} new`
                : "Resume auto-scroll"
            }
            aria-label="Resume auto-scroll"
          >
            ↓
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Caption(props: {
  harness: string | null;
  live: boolean;
  children?: ReactNode;
}): ReactNode {
  return (
    <div className="t-caption">
      {props.live ? (
        <Tooltip text="Streaming from the attempt's sandbox — refreshes every 5s">
          <span className="t-live pulse">● Live</span>
        </Tooltip>
      ) : null}
      {props.harness ? (
        <HarnessIcon harness={props.harness} size={13} showLabel />
      ) : (
        <span className="dim">Unknown harness</span>
      )}
      {props.children}
    </div>
  );
}

function Footer(): ReactNode {
  return (
    <div className="t-footer">
      <Spinner label="Streaming…" />
    </div>
  );
}

// ---- per-task sub-tabs (v7 §1) ----

const TASK_TITLE_CLIP = 32;

function clipTitle(s: string): string {
  return s.length > TASK_TITLE_CLIP ? `${s.slice(0, TASK_TITLE_CLIP - 1)}…` : s;
}

interface TrTabGlyph {
  glyph: string;
  tone: string;
  label: string;
}

/**
 * v7.5 item 4: per-tab status source. The frozen task payload (GET
 * /api/attempts/:id/tasks via the `taskRecords` prop) wins; the round-7
 * tasks.json-derived `taskStatuses` map is the fallback. `undefined` means no
 * record at all (e.g. v1-era attempts) — callers render NO indicator then.
 */
function resolveTaskStatus(
  taskId: string,
  records: Record<string, AttemptTaskJson> | null | undefined,
  statuses: Record<string, TranscriptTaskStatus> | undefined,
): TranscriptTaskStatus | undefined {
  const rec = records?.[taskId];
  if (rec !== undefined) return { status: rec.status, skipped: rec.skipped };
  return statuses?.[taskId];
}

/** Static status glyph per sub-tab (no spinners — single-animation rule). */
function taskTabGlyph(st: TranscriptTaskStatus): TrTabGlyph {
  if (st.skipped) return { glyph: "⊘", tone: "dim", label: "Skipped (failed dependency)" };
  const s = (st.status ?? "").toLowerCase();
  if (s === "completed" || s === "done") return { glyph: "✓", tone: "green", label: "Completed" };
  if (s === "failed" || s === "error") return { glyph: "✗", tone: "red", label: "Failed" };
  if (s === "in_progress" || s === "running") {
    return { glyph: "◔", tone: "accent", label: "In Progress" };
  }
  if (s === "pending" || s === "created" || s === "assigned") {
    return { glyph: "○", tone: "dim", label: "Pending" };
  }
  if (s === "") return { glyph: "•", tone: "neutral", label: "Status unknown" };
  return { glyph: "•", tone: "neutral", label: s };
}

/** Severity rank for the All-tab aggregate — higher is worse. */
function statusRank(st: TranscriptTaskStatus): number {
  if (st.skipped) return 2;
  const s = (st.status ?? "").toLowerCase();
  if (s === "failed" || s === "error") return 5;
  if (s === "in_progress" || s === "running") return 4;
  if (s === "pending" || s === "created" || s === "assigned") return 3;
  if (s === "completed" || s === "done") return 0;
  return 1; // unknown status string — worse than completed, better than pending
}

/**
 * v7.5 item 4 convention: the All tab shows the WORST known task status
 * (failed > in-progress > pending > skipped > unknown > completed); when no
 * task has a known status (records absent — v1-era) it shows no indicator.
 */
function aggregateTabGlyph(
  tabs: string[],
  resolve: (taskId: string) => TranscriptTaskStatus | undefined,
): TrTabGlyph | null {
  let worst: TranscriptTaskStatus | null = null;
  let worstRank = -1;
  for (const taskId of tabs) {
    const st = resolve(taskId);
    if (st === undefined) continue;
    const rank = statusRank(st);
    if (rank > worstRank) {
      worstRank = rank;
      worst = st;
    }
  }
  return worst === null ? null : taskTabGlyph(worst);
}

// ---- v7.7 item 7: chip economics (LOCAL formatters by frozen contract —
// the shared components/format.ts stays untouched). Inline pill segments are
// COMPACT; the hover card carries the full-precision breakdown. Duration is
// the task-record createdAt→finishedAt span — i.e. the task LIFETIME: DAG
// dependents are created upfront, so their span includes dependency-pending
// time (accepted + documented in the hover note). ----

/** "<$0.01" | "$0.02" — null in, null out (segment omitted). */
function chipCost(usd: number | null): string | null {
  if (usd === null || Number.isNaN(usd)) return null;
  return usd < 0.005 ? "<$0.01" : `$${usd.toFixed(2)}`;
}

/** Compact no-space duration: "41s" / "1m12s" / "2h05m" — null in, null out. */
function chipDuration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${String(totalSec)}s`;
  const min = Math.floor(totalSec / 60);
  if (min < 60) return `${String(min)}m${String(totalSec % 60).padStart(2, "0")}s`;
  return `${String(Math.floor(min / 60))}h${String(min % 60).padStart(2, "0")}m`;
}

/** input + output + cacheRead + cacheWrite; null when no token record. */
function tokensSum(t: TokenTotalsJson | null): number | null {
  if (t === null) return null;
  return t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;
}

/** fmtTokens of the sum with the trailing ".0" trimmed ("356.0k" → "356k"). */
function chipTokens(t: TokenTotalsJson | null): string | null {
  const sum = tokensSum(t);
  if (sum === null) return null;
  return fmtTokens(sum).replace(/\.0(?=[kM]$)/, "");
}

/**
 * Non-null inline segments in frozen order (cost · duration · tokens).
 * Null = NO metric known — the pill renders exactly as pre-v7.7 (back-compat).
 */
function chipSegments(m: TranscriptTotals): string[] | null {
  const segs = [chipCost(m.costUsd), chipDuration(m.durationMs), chipTokens(m.tokens)].filter(
    (s): s is string => s !== null,
  );
  return segs.length === 0 ? null : segs;
}

/** "in 12.3k · out 4.1k · cacheR 301k · cacheW 38.2k" | "—". */
function tokensBreakdown(t: TokenTotalsJson | null): string {
  if (t === null) return "—";
  return `in ${fmtTokens(t.inputTokens)} · out ${fmtTokens(t.outputTokens)} · cacheR ${fmtTokens(
    t.cacheReadTokens,
  )} · cacheW ${fmtTokens(t.cacheWriteTokens)}`;
}

function ChipCardRow(props: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="tip-card-row">
      <span className="tip-card-label">{props.label}</span>
      <span className="tip-card-value">{props.children}</span>
    </div>
  );
}

/** Item 7 hover breakdown for one task pill — "—" for every null field. */
function TaskChipCard(props: {
  rec: AttemptTaskJson;
  taskNo: number;
  /** Round-10 item 2: executing member (crown for the lead); null ⇒ row absent. */
  member?: TaskMemberInfo | null;
}): ReactNode {
  const rec = props.rec;
  const member = props.member ?? null;
  const info = taskTabGlyph({ status: rec.status, skipped: rec.skipped });
  return (
    <div className="tip-card">
      <div className="tip-card-title">
        Task {props.taskNo}
        {rec.title !== null ? ` · ${rec.title}` : ""}
      </div>
      <ChipCardRow label="Id">
        <code>{rec.id}</code>
      </ChipCardRow>
      <ChipCardRow label="Status">
        <span className={`tone-${info.tone}`}>
          {info.glyph} {info.label}
        </span>
      </ChipCardRow>
      <ChipCardRow label="Cost">{fmtCost(rec.costUsd)}</ChipCardRow>
      <ChipCardRow label="Duration">{fmtDuration(rec.durationMs ?? null)}</ChipCardRow>
      <ChipCardRow label="Tokens">{tokensBreakdown(rec.tokens)}</ChipCardRow>
      <ChipCardRow label="Model">{rec.tokens?.model ?? "—"}</ChipCardRow>
      {member !== null ? (
        <ChipCardRow label="Member">
          <span className="tm-member-val">
            {member.isLead ? <CrownIcon size={11} className="tm-crown" /> : null}
            <HarnessIcon harness={member.provider} size={11} plain />
            {member.name}
          </span>
        </ChipCardRow>
      ) : null}
      <ChipCardRow label="Agent">{rec.agentId ?? "—"}</ChipCardRow>
      <ChipCardRow label="Created">{fmtDate(rec.createdAt ?? null)}</ChipCardRow>
      <ChipCardRow label="Finished">{fmtDate(rec.finishedAt ?? null)}</ChipCardRow>
      {(rec.durationMs ?? null) !== null ? (
        <div className="t-chip-note">
          Duration = task lifetime (created → finished); dependents include dependency-pending time.
        </div>
      ) : null}
    </div>
  );
}

/** Item 7 hover breakdown for the All pill — attempt totals, not Σ task costs. */
function AllChipCard(props: { totals: TranscriptTotals; statusLabel: string | null }): ReactNode {
  return (
    <div className="tip-card">
      <div className="tip-card-title">All tasks · attempt totals</div>
      {props.statusLabel !== null ? (
        <ChipCardRow label="Status">Worst task: {props.statusLabel}</ChipCardRow>
      ) : null}
      <ChipCardRow label="Cost">{fmtCost(props.totals.costUsd)}</ChipCardRow>
      <ChipCardRow label="Duration">{fmtDuration(props.totals.durationMs)}</ChipCardRow>
      <ChipCardRow label="Tokens">{tokensBreakdown(props.totals.tokens)}</ChipCardRow>
      <ChipCardRow label="Model">{props.totals.tokens?.model ?? "—"}</ChipCardRow>
      <div className="t-chip-note">
        Attempt totals — recompute-priced; may exceed Σ harness-reported task costs. Includes rows
        without a task id.
      </div>
    </div>
  );
}

function AttemptOutcomeCard(props: { outcome: TranscriptOutcome | null }): ReactNode {
  const outcome = props.outcome;
  if (outcome === null) return null;
  const judges = outcome.judgments.filter((j) => j.kind !== "deterministic");
  const failed = outcome.judgments.filter((j) => !j.pass);
  const primary = failed[0] ?? judges[0] ?? outcome.judgments[0] ?? null;
  return (
    <div className="t-attempt-outcome">
      <div className="t-attempt-outcome-main">
        <span className="t-result-head">Final Outcome</span>
        <StatusScore status={outcome.status} score={outcome.score} />
        {judges.length > 0 ? (
          <span className="t-outcome-judges">
            {judges.filter((j) => j.pass).length}/{judges.length} judge verdicts passed
          </span>
        ) : null}
      </div>
      {primary !== null ? (
        <div className="t-attempt-outcome-detail">
          <span className={primary.pass ? "tone-green" : "tone-red"}>
            {primary.pass ? "Passed" : "Failed"}
          </span>{" "}
          <span>
            {primary.dimension !== null
              ? humanizeKey(primary.dimension)
              : humanizeKey(primary.name)}
          </span>
          {primary.score !== null ? (
            <span className="dim"> · {fmtScore(primary.score)}</span>
          ) : null}
          {primary.reasoning ? <div>{primary.reasoning}</div> : null}
        </div>
      ) : (
        <div className="t-attempt-outcome-detail dim">
          No deterministic checks or judge verdicts have been recorded yet.
        </div>
      )}
    </div>
  );
}

function TaskTabs(props: {
  tabs: string[];
  active: string | null;
  titles?: Record<string, string>;
  statuses?: Record<string, TranscriptTaskStatus>;
  /** v7.5: frozen per-task records — preferred status source (see resolveTaskStatus). */
  records?: Record<string, AttemptTaskJson> | null;
  /** v7.7 item 7: attempt totals behind the All pill; null/absent = plain pill. */
  totals?: TranscriptTotals | null;
  /** Round-10 item 2: agentId → member attribution for the pill hover cards. */
  members?: Record<string, TaskMemberInfo> | null;
  onSelect: (taskId: string | null) => void;
}): ReactNode {
  const resolve = (taskId: string): TranscriptTaskStatus | undefined =>
    resolveTaskStatus(taskId, props.records, props.statuses);
  const glyphFor = (taskId: string): TrTabGlyph | null => {
    const st = resolve(taskId);
    return st !== undefined ? taskTabGlyph(st) : null;
  };
  const allGlyph = aggregateTabGlyph(props.tabs, resolve);
  const totals = props.totals ?? null;
  const allSegs = totals !== null ? chipSegments(totals) : null;
  const allButton = (
    <button
      type="button"
      className={props.active === null ? "t-tasktab selected" : "t-tasktab"}
      title={
        allSegs === null
          ? `All events, including rows without a task id${
              allGlyph ? `\nWorst task status: ${allGlyph.label}` : ""
            }`
          : undefined
      }
      onClick={() => props.onSelect(null)}
    >
      {allGlyph !== null ? (
        <span className={`t-tasktab-glyph tone-${allGlyph.tone}`} aria-hidden="true">
          {allGlyph.glyph}
        </span>
      ) : null}
      All
      {allSegs !== null ? <span className="t-tasktab-meta">{allSegs.join(" · ")}</span> : null}
    </button>
  );
  return (
    <div className="t-tasktabs">
      {allSegs !== null && totals !== null ? (
        <Tooltip wide text={<AllChipCard totals={totals} statusLabel={allGlyph?.label ?? null} />}>
          {allButton}
        </Tooltip>
      ) : (
        allButton
      )}
      {props.tabs.map((taskId, i) => (
        <TaskTabPill
          key={taskId}
          taskId={taskId}
          taskNo={i + 1}
          selected={props.active === taskId}
          glyph={glyphFor(taskId)}
          title={props.titles?.[taskId]}
          rec={props.records?.[taskId]}
          member={memberOf(props.records?.[taskId], props.members)}
          onSelect={props.onSelect}
        />
      ))}
    </div>
  );
}

/** One task pill — item 7 inline economics + rich hover when a record exists. */
function TaskTabPill(props: {
  taskId: string;
  taskNo: number;
  selected: boolean;
  glyph: TrTabGlyph | null;
  title: string | undefined;
  rec: AttemptTaskJson | undefined;
  /** Round-10 item 2: executing member for the hover card; null ⇒ row absent. */
  member: TaskMemberInfo | null;
  onSelect: (taskId: string | null) => void;
}): ReactNode {
  const { taskId, glyph, title, rec } = props;
  const segs =
    rec !== undefined
      ? chipSegments({
          costUsd: rec.costUsd,
          durationMs: rec.durationMs ?? null,
          tokens: rec.tokens,
        })
      : null;
  const button = (
    <button
      type="button"
      className={props.selected ? "t-tasktab selected" : "t-tasktab"}
      // a record carries the rich hover card instead — no double tooltip
      title={
        rec === undefined ? (glyph !== null ? `${taskId}\n${glyph.label}` : taskId) : undefined
      }
      onClick={() => props.onSelect(taskId)}
    >
      {glyph !== null ? (
        <span className={`t-tasktab-glyph tone-${glyph.tone}`} aria-hidden="true">
          {glyph.glyph}
        </span>
      ) : null}
      Task {props.taskNo}
      {segs !== null ? (
        // metrics REPLACE the inline title (it moves into the hover card)
        <span className="t-tasktab-meta">{segs.join(" · ")}</span>
      ) : title !== undefined ? (
        <span className="t-tasktab-title"> · {clipTitle(title)}</span>
      ) : null}
    </button>
  );
  // Back-compat sacred: no record (pre-v7.5 server / v1-era) ⇒ the exact
  // pre-v7.7 pill incl. its native title tooltip.
  if (rec === undefined) return button;
  return (
    <Tooltip wide text={<TaskChipCard rec={rec} taskNo={props.taskNo} member={props.member} />}>
      {button}
    </Tooltip>
  );
}

/**
 * v7.5 items 2/6 + v7.7 item 8: outcome block for the SELECTED sub-tab —
 * sticky flush under the single-row sticky bar (top = measured --tr-bar-h),
 * collapsible (default expanded with the details clamped as before; collapsed
 * = status + cost one-liner), and tinted by status tone so it reads as the
 * task's OUTCOME, not another gray transcript bubble. Cascade-skipped still
 * reads distinctly from a real error (v6 §9 semantics); every field degrades
 * to absent/"—" on all-null records ("task-ids" source, v1-era rows).
 */
function TaskTabHeader(props: {
  rec: AttemptTaskJson;
  /** Round-10 item 2: executing member (name + harness icon, crown for the lead). */
  member?: TaskMemberInfo | null;
}): ReactNode {
  const rec = props.rec;
  const member = props.member ?? null;
  const [open, setOpen] = useState(false);
  const info = taskTabGlyph({ status: rec.status, skipped: rec.skipped });
  const statusTip = [rec.id, info.label, rec.agentId !== null ? `Agent ${rec.agentId}` : null]
    .filter((line): line is string => line !== null)
    .join("\n");
  const hasDetail = rec.error !== null || rec.outcome !== null;
  return (
    <div className="t-taskhead-sticky">
      <div className={`t-taskhead card-${info.tone}`}>
        <div className="t-taskhead-row">
          {hasDetail ? (
            <button
              type="button"
              className="t-toggle t-taskhead-chevron"
              aria-expanded={open}
              title={open ? "Collapse outcome" : "Expand outcome"}
              onClick={() => setOpen(!open)}
            >
              {open ? "▾" : "▸"}
            </button>
          ) : null}
          <Tooltip text={statusTip}>
            <span className={`t-taskhead-status tone-${info.tone}`}>
              <span className="t-tasktab-glyph" aria-hidden="true">
                {info.glyph}
              </span>
              {info.label}
            </span>
          </Tooltip>
          {/* Same labeling as the round-7 member cost: harness-reported Σ. */}
          <Tooltip text="Harness-reported Σ session cost for this task — a recomputed attempt cost may differ">
            <span className="t-taskhead-cost">
              <CostBadge costUsd={rec.costUsd} source={null} />
            </span>
          </Tooltip>
          {/* Round-10 item 2: who ran this task — absent when unattributed. */}
          {member !== null ? (
            <span className="t-taskhead-member">
              <TaskMemberChip member={member} />
            </span>
          ) : null}
        </div>
        {open && rec.error !== null ? (
          <div className={rec.skipped ? "t-taskhead-detail skip" : "t-taskhead-detail error"}>
            <div className="t-result-head">
              {rec.skipped ? "⊘ Skipped (failed dependency)" : "↳ Error"}
            </div>
            <ClippedText text={rec.error} clip={ERROR_RESULT_CLIP} />
          </div>
        ) : null}
        {open && rec.outcome !== null ? (
          <div className="t-taskhead-detail">
            <div className="t-result-head">↳ Outcome</div>
            <ClippedText text={rec.outcome} clip={RESULT_CLIP} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---- per-event-type components (item 15; polish item 8) ----

const ROLE_GLYPHS: Record<ParsedMessage["role"], string> = {
  assistant: "✦",
  user: "◆",
  system: "○",
};

function fmtTime(iso: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString(undefined, { hour12: false });
}

function MessageCard(props: {
  msg: ParsedMessage;
  resultById: Map<string, ToolResultBlock>;
  callIds: Set<string>;
}): ReactNode {
  const { msg, resultById, callIds } = props;
  const rendered: ReactNode[] = [];
  // blocks never reorder within a parsed message — positional keys are stable
  let pos = 0;
  for (const block of msg.content) {
    const key = `b${pos++}`;
    switch (block.type) {
      case "text": {
        if (block.text) {
          rendered.push(<TextView text={block.text} role={msg.role} key={key} />);
        }
        break;
      }
      case "thinking": {
        rendered.push(<Thinking text={block.thinking} key={key} />);
        break;
      }
      case "tool_use": {
        rendered.push(
          <ToolCard call={block} result={resultById.get(block.id) ?? null} key={key} />,
        );
        break;
      }
      case "tool_result": {
        // paired results render inline under their call; only orphans render standalone
        if (!callIds.has(block.tool_use_id)) {
          rendered.push(<OrphanResult result={block} key={key} />);
        }
        break;
      }
      case "provider_meta": {
        rendered.push(<MetaLineView block={block} key={key} />);
        break;
      }
    }
  }
  if (rendered.length === 0) {
    const onlyPairedResults = msg.content.every(
      (b) => b.type === "tool_result" && callIds.has(b.tool_use_id),
    );
    if (onlyPairedResults) return null; // those rows render under their tool calls
    rendered.push(
      <div className="t-text dim" key="empty">
        (Empty message)
      </div>,
    );
  }
  const time = fmtTime(msg.timestamp);
  return (
    <div className={`t-msg t-${msg.role}`}>
      <div className="t-head">
        <span className={`t-glyph t-glyph-${msg.role}`} aria-hidden="true">
          {ROLE_GLYPHS[msg.role]}
        </span>
        <span className="t-role">{msg.role}</span>
        {time ? <span className="t-time">{time}</span> : null}
      </div>
      {rendered}
    </div>
  );
}

/** Assistant prose renders as markdown (item 8); other roles stay plain pre-wrap text. */
function TextView(props: { text: string; role: ParsedMessage["role"] }): ReactNode {
  if (props.role === "assistant") {
    return (
      <div className="t-text">
        <Markdown text={props.text} />
      </div>
    );
  }
  return <div className="t-text t-text-plain">{props.text}</div>;
}

function Thinking(props: { text: string }): ReactNode {
  const collapsible = props.text.length > THINKING_COLLAPSE;
  const [open, setOpen] = useState(!collapsible);
  if (!open) {
    return (
      <button type="button" className="t-toggle" onClick={() => setOpen(true)}>
        ▸ Thinking ({props.text.length.toLocaleString()} chars)
      </button>
    );
  }
  return (
    <div className="t-thinking-wrap">
      {collapsible ? (
        <button type="button" className="t-toggle" onClick={() => setOpen(false)}>
          ▾ Thinking ({props.text.length.toLocaleString()} chars)
        </button>
      ) : null}
      <div className="t-thinking">{props.text}</div>
    </div>
  );
}

/** Result state as a shared status glyph (item 8) — ✓ / ✗ / ○ with hover info. */
function ToolStatus(props: { result: ToolResultBlock | null }): ReactNode {
  const { result } = props;
  if (result === null) return <StatusBadge status="pending" tip="No result captured" />;
  if (result.isError) return <StatusBadge status="failed" tip="Tool returned an error" />;
  return <StatusBadge status="passed" tip="Tool succeeded" />;
}

/** Keys most likely to be the human-meaningful argument, in preference order. */
const PREVIEW_KEYS = ["command", "file_path", "path", "url", "pattern"];

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function squash(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Single-line dim preview of the first meaningful string argument (item 8). */
function argPreview(input: unknown): string | null {
  if (typeof input === "string" && input.trim().length > 0) return squash(input);
  const rec = plainRecord(input);
  if (!rec) return null;
  for (const key of PREVIEW_KEYS) {
    const v = rec[key];
    if (typeof v === "string" && v.trim().length > 0) return squash(v);
  }
  for (const v of Object.values(rec)) {
    if (typeof v === "string" && v.trim().length > 0) return squash(v);
  }
  return null;
}

function ToolCard(props: { call: ToolUseBlock; result: ToolResultBlock | null }): ReactNode {
  const { call, result } = props;
  const [argsOpen, setArgsOpen] = useState(false);
  const preview = argPreview(call.input);
  const keyCount = Object.keys(plainRecord(call.input) ?? {}).length;
  const hasInput = call.input !== undefined && call.input !== null;
  const collapseArgs = hasInput && keyCount > 1;
  return (
    <div className={`t-tool${result?.isError ? " t-tool-error" : ""}`}>
      <div className="t-tool-head">
        <span className="t-tool-name">⚙ {call.name}</span>
        {preview ? <span className="t-tool-preview">{preview}</span> : null}
        <ToolStatus result={result} />
      </div>
      {collapseArgs ? (
        <div className="t-tool-args">
          <button type="button" className="t-toggle" onClick={() => setArgsOpen(!argsOpen)}>
            {argsOpen ? "▾" : "▸"} Args ({keyCount})
          </button>
          {argsOpen ? <JsonView value={call.input} collapseDepth={1} /> : null}
        </div>
      ) : null}
      {hasInput && !collapseArgs ? <JsonView value={call.input} collapseDepth={1} /> : null}
      {result ? <ResultBody result={result} /> : null}
    </div>
  );
}

function OrphanResult(props: { result: ToolResultBlock }): ReactNode {
  return (
    <div className={`t-tool${props.result.isError ? " t-tool-error" : ""}`}>
      <div className="t-tool-head">
        <span className="t-tool-name">
          ⚙ Tool Result <span className="dim">{props.result.tool_use_id}</span>
        </span>
        <ToolStatus result={props.result} />
      </div>
      <ResultBody result={props.result} />
    </div>
  );
}

function ClippedText(props: { text: string; clip?: number }): ReactNode {
  const clip = props.clip ?? RESULT_CLIP;
  const [full, setFull] = useState(false);
  const clippable = props.text.length > clip;
  const clipped = !full && clippable;
  return (
    <>
      <pre>{clipped ? `${props.text.slice(0, clip)}…` : props.text}</pre>
      {clippable ? (
        <button type="button" className="t-toggle" onClick={() => setFull(!full)}>
          {full ? "Show Less" : `Show All (${props.text.length.toLocaleString()} chars)`}
        </button>
      ) : null}
    </>
  );
}

/**
 * v7.7 item 6: tool outputs collapse by DEFAULT (they dominate the view);
 * errors stay visible. The sticky bar's expand/collapse-all signal overrides
 * the local state once per nonce, then per-item toggles take over again.
 */
function ResultBody(props: { result: ToolResultBlock }): ReactNode {
  const { result } = props;
  const bulk = useContext(ResultBulkContext);
  // a freshly streamed-in result must NOT apply an older bulk signal on mount
  const applied = useRef(bulk.nonce);
  const [open, setOpen] = useState(result.isError);
  useEffect(() => {
    if (bulk.nonce === applied.current) return;
    applied.current = bulk.nonce;
    setOpen(bulk.mode === "expand");
  }, [bulk]);
  if (!result.content) {
    return <div className="t-tool-result dim">(Empty result)</div>;
  }
  return (
    <div className={`t-tool-result${result.isError ? " error" : ""}`}>
      <button type="button" className="t-toggle t-result-toggle" onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} {result.isError ? "Error" : "Result"} (
        {result.content.length.toLocaleString()} chars)
      </button>
      {open ? (
        <ClippedText
          text={result.content}
          clip={result.isError ? ERROR_RESULT_CLIP : RESULT_CLIP}
        />
      ) : null}
    </div>
  );
}

const META_KIND_LABELS: Record<ProviderMetaBlock["kind"], string> = {
  status: "Status",
  structured_output: "Structured Output",
  internal: "Internal",
  helper: "Helper",
  lifecycle: "Lifecycle",
  result: "Result",
  file_change: "File Change",
  parse_error: "Parse Error",
  unknown: "Unknown",
};

function MetaLineView(props: { block: ProviderMetaBlock }): ReactNode {
  const { block } = props;
  const [open, setOpen] = useState(false);
  const dataType = typeof block.data.type === "string" ? block.data.type : "";
  return (
    <div className="t-meta">
      <button type="button" className="t-toggle" onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} · {META_KIND_LABELS[block.kind]}
        {dataType ? `: ${dataType}` : ""}
      </button>
      {open ? <JsonView value={block.data} collapseDepth={1} /> : null}
    </div>
  );
}

function MetaGroup(props: { lines: MetaLine[] }): ReactNode {
  const [open, setOpen] = useState(false);
  if (props.lines.length === 1) return <MetaLineView block={props.lines[0].block} />;
  return (
    <div className="t-meta-group">
      <button type="button" className="t-toggle" onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} · {props.lines.length} Internal Events
      </button>
      {open ? props.lines.map((l) => <MetaLineView block={l.block} key={l.key} />) : null}
    </div>
  );
}

/** Raw fallback for rows the parser could not decode (item 15 — nothing dropped). */
function RawRow(props: { cli: string; content: string }): ReactNode {
  return (
    <div className="t-raw">
      <div className="t-raw-head">Unparsed · {props.cli}</div>
      <ClippedText text={props.content} clip={RAW_CLIP} />
    </div>
  );
}
