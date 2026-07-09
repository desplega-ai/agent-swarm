import {
  ChevronDown,
  ChevronRight,
  Clock,
  History,
  Loader2,
  Radio,
  RotateCcw,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "@/api/client";
import { useAgents } from "@/api/hooks/use-agents";
import { useTasks } from "@/api/hooks/use-tasks";
import type { AgentTask, AgentTaskStatus, AgentWithTasks } from "@/api/types";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatCost } from "@/lib/cost-format";
import { formatDurationMs } from "@/lib/format-duration-ms";
import { formatTokens } from "@/lib/format-tokens";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 300;
const MIN_BAR_WIDTH = 10;
const LABEL_WIDTH = 208;
const ROW_HEIGHT = 36;
const BAR_HEIGHT = 24;
/** Zoom level the view opens at, and returns to on "reset zoom" (8h). */
const DEFAULT_ZOOM_INDEX = 5;
/** Gap kept between the now-line and the right edge while following live. */
const LIVE_EDGE_GAP_PX = 72;
/** Scroll drift, in px, that counts as the user taking over from live-follow. */
const FOLLOW_BREAK_PX = 24;
/** Height of the collapsed "N idle agents" accordion row. */
const IDLE_SUMMARY_HEIGHT = 32;
// Horizontal breathing room required between two bars before they may share a
// row. Without it, back-to-back tasks render as one continuous smear.
const BAR_GAP_PX = 4;
// A lane with more concurrency than this stops growing; the overflow tasks
// stack onto the last row. Keeps one pathological agent from owning the viewport.
const MAX_ROWS_PER_LANE = 8;
const HEADER_HEIGHT = 40;
const LIVE_PADDING_MS = 5 * 60 * 1000;
const MIN_VIEWPORT_WIDTH = 640;
/**
 * How often the "now" reference advances. At the tightest zoom (1h across the
 * viewport) the now-line moves under a pixel per 5s, so ticking faster buys no
 * visible motion and costs a full re-layout each tick.
 */
const NOW_TICK_MS = 5_000;
/**
 * `createdAfter` feeds the react-query key. Quantising it keeps the key stable
 * between buckets — a key that moves with the clock refetches (and, without
 * `keepPreviousData`, blanks the chart) on every tick.
 */
const CREATED_AFTER_BUCKET_MS = 15 * 60 * 1000;

/**
 * Statuses the timeline plots. A bar means "this task occupied an agent for
 * this span", so a task that was never picked up has no span to draw. Prod
 * bears this out: of 22.8k tasks at rest, every one is completed / failed /
 * cancelled / superseded — the queue states are transient by nature.
 */
const TIMELINE_STATUSES: ReadonlySet<AgentTaskStatus> = new Set<AgentTaskStatus>([
  "in_progress",
  "paused",
  "reviewing",
  "completed",
  "failed",
  "cancelled",
  "superseded",
]);
// Deep end matters: real tasks median ~2min (prod), so the tightest levels
// resolve sub-minute work — at "30s" the axis splits into 5-second ticks.
const ZOOM_LEVELS = [
  { label: "30s", ms: 30 * 1000 },
  { label: "2m", ms: 2 * 60 * 1000 },
  { label: "10m", ms: 10 * 60 * 1000 },
  { label: "1h", ms: 60 * 60 * 1000 },
  { label: "3h", ms: 3 * 60 * 60 * 1000 },
  { label: "8h", ms: 8 * 60 * 60 * 1000 },
  { label: "24h", ms: 24 * 60 * 60 * 1000 },
  { label: "3d", ms: 3 * 24 * 60 * 60 * 1000 },
  { label: "7d", ms: 7 * 24 * 60 * 60 * 1000 },
] as const;

type TimelineTask = AgentTask & { agentId: string | null };

interface Lane {
  id: string;
  name: string;
  role?: string;
  isLead: boolean;
  /** False for the synthetic "Unassigned" lane — it has no agent to link to. */
  isAgent: boolean;
  tasks: TimelineTask[];
}

/** A lane rendered as one or more stacked rows of non-overlapping bars. */
/**
 * One rendered element in a lane row: a task bar, or a cluster chip standing
 * in for a burst of tasks too small to draw individually at this zoom.
 * Clicking a cluster zooms into its span.
 */
type RowItem =
  | { kind: "task"; id: string; task: TimelineTask; left: number; right: number }
  | {
      kind: "cluster";
      id: string;
      tasks: TimelineTask[];
      left: number;
      right: number;
      startMs: number;
      endMs: number;
    };

interface LaneLayout {
  lane: Lane;
  rows: RowItem[][];
  top: number;
  height: number;
}

/** Pixel box of a rendered bar, in timeline-content coordinates. */
interface TaskGeometry {
  left: number;
  right: number;
  centerY: number;
}

interface TimelineLayout {
  laneLayouts: LaneLayout[];
  geometry: Map<string, TaskGeometry>;
  contentHeight: number;
}

/** Bars narrower than this are cluster candidates at the current zoom. */
const CLUSTER_MAX_BAR_PX = 14;
/** Max horizontal gap between tiny bars that still reads as one burst. */
const CLUSTER_GAP_PX = 8;
/** A burst needs at least this many tiny tasks to collapse into a chip. */
const CLUSTER_MIN_TASKS = 3;
/** Minimum rendered width of a cluster chip. */
const CLUSTER_MIN_WIDTH_PX = 28;

function statusBarClass(status: AgentTaskStatus): string {
  switch (status) {
    case "completed":
      return "border-status-success bg-status-success/80 text-status-success-foreground";
    case "failed":
      return "border-status-error bg-status-error/80 text-status-error-foreground";
    case "in_progress":
      return "border-status-active bg-status-active/85 text-status-active-foreground";
    case "paused":
    case "reviewing":
      return "border-status-paused bg-status-paused/80 text-status-paused-foreground";
    case "pending":
      return "border-status-pending bg-status-pending/80 text-status-pending-foreground";
    case "offered":
      return "border-status-info bg-status-info/80 text-status-info-foreground";
    case "cancelled":
    case "backlog":
    case "unassigned":
      return "border-status-neutral bg-status-neutral/75 text-status-neutral-foreground";
    case "superseded":
      return "border-status-warning bg-status-warning/75 text-status-warning-foreground";
    default:
      return "border-status-neutral bg-status-neutral/75 text-status-neutral-foreground";
  }
}

/** Saturated status fill, for use on surfaces where tinted text would wash out. */
function statusDotClass(status: AgentTaskStatus): string {
  switch (status) {
    case "completed":
      return "bg-status-success";
    case "failed":
      return "bg-status-error";
    case "in_progress":
      return "bg-status-active";
    case "paused":
    case "reviewing":
      return "bg-status-paused";
    case "pending":
      return "bg-status-pending";
    case "offered":
      return "bg-status-info";
    case "superseded":
      return "bg-status-warning";
    default:
      return "bg-status-neutral";
  }
}

function taskEndMs(task: TimelineTask, nowMs: number): number {
  if (task.finishedAt) return new Date(task.finishedAt).getTime();
  if (task.status === "in_progress" || task.status === "paused") return nowMs;
  return new Date(task.lastUpdatedAt || task.createdAt).getTime();
}

function taskTitle(task: TimelineTask): string {
  return task.task.replace(/\s+/g, " ").trim() || task.id;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function formatTime(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
}

function formatAxisLabel(ms: number, windowMs: number): string {
  const date = new Date(ms);
  // Sub-15min windows tick at seconds granularity — without :ss every label
  // in view reads identically.
  if (windowMs <= 15 * 60 * 1000) {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(date);
  }
  if (windowMs <= 8 * 60 * 60 * 1000) {
    return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
  }).format(date);
}

/** Tick spacing for a zoom window: smallest interval giving ≤ ~8 ticks/view. */
function tickIntervalMs(windowMs: number): number {
  const targetTicks = 8;
  const rough = windowMs / targetTicks;
  const intervals = [
    5 * 1000,
    15 * 1000,
    30 * 1000,
    60 * 1000,
    2 * 60 * 1000,
    5 * 60 * 1000,
    15 * 60 * 1000,
    30 * 60 * 1000,
    60 * 60 * 1000,
    3 * 60 * 60 * 1000,
    6 * 60 * 60 * 1000,
    12 * 60 * 60 * 1000,
    24 * 60 * 60 * 1000,
  ];
  return intervals.find((value) => value >= rough) ?? intervals[intervals.length - 1]!;
}

/**
 * Tick timestamps for [startMs, endMs] only. Callers pass the *visible* range,
 * not the loaded extent — at the 30s zoom a day of content is ~17k ticks, and
 * DOM-ing all of them (as the old full-extent version did at coarser zooms)
 * would hang the tab.
 */
function buildTicks(startMs: number, endMs: number, intervalMs: number): number[] {
  const first = Math.ceil(startMs / intervalMs) * intervalMs;
  const ticks: number[] = [];
  for (let t = first; t <= endMs; t += intervalMs) ticks.push(t);
  return ticks;
}

function mergeTasks(...groups: AgentTask[][]): TimelineTask[] {
  const byId = new Map<string, TimelineTask>();
  for (const group of groups) {
    for (const task of group) byId.set(task.id, task);
  }
  return [...byId.values()].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
}

function buildLanes(agents: AgentWithTasks[], tasks: TimelineTask[]): Lane[] {
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const taskBuckets = new Map<string, TimelineTask[]>();
  for (const task of tasks) {
    const laneId = task.agentId ?? "unassigned";
    const bucket = taskBuckets.get(laneId) ?? [];
    bucket.push(task);
    taskBuckets.set(laneId, bucket);
  }

  const lanes: Lane[] = agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    role: agent.role || agent.description,
    isLead: !!agent.isLead,
    isAgent: true,
    tasks: taskBuckets.get(agent.id) ?? [],
  }));

  for (const [laneId, laneTasks] of taskBuckets) {
    if (laneId === "unassigned") {
      lanes.push({
        id: laneId,
        name: "Unassigned",
        isLead: false,
        isAgent: false,
        tasks: laneTasks,
      });
      continue;
    }
    if (!agentById.has(laneId)) {
      // A task pointing at an agent we don't have a record for — still a real
      // agent id, so it links.
      lanes.push({
        id: laneId,
        name: shortId(laneId),
        isLead: false,
        isAgent: true,
        tasks: laneTasks,
      });
    }
  }

  // Every registered agent keeps its lane, busy or not — an idle agent is
  // information, not noise.
  return lanes.sort((a, b) => {
    if (a.isLead !== b.isLead) return a.isLead ? -1 : 1;
    return b.tasks.length - a.tasks.length || a.name.localeCompare(b.name);
  });
}

const MIN_WINDOW_MS = ZOOM_LEVELS[0].ms;
const MAX_WINDOW_MS = ZOOM_LEVELS[ZOOM_LEVELS.length - 1].ms;
const DEFAULT_WINDOW_MS = ZOOM_LEVELS[DEFAULT_ZOOM_INDEX].ms;

function clampWindowMs(ms: number): number {
  return Math.max(MIN_WINDOW_MS, Math.min(MAX_WINDOW_MS, ms));
}

/** Human label for a continuous zoom window: "30s", "45m", "2.6h", "3d". */
function formatWindowLabel(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 60 * 60_000) {
    const m = ms / 60_000;
    return `${m < 10 && m % 1 ? m.toFixed(1) : Math.round(m)}m`;
  }
  if (ms < 24 * 60 * 60_000) {
    const h = ms / 3_600_000;
    return `${h < 10 && h % 1 ? h.toFixed(1) : Math.round(h)}h`;
  }
  const d = ms / 86_400_000;
  return `${d % 1 ? d.toFixed(1) : d}d`;
}

function barBox(
  task: TimelineTask,
  nowMs: number,
  timelineStartMs: number,
  pxPerMs: number,
): { left: number; right: number } {
  const start = new Date(task.createdAt).getTime();
  const end = Math.max(start + 1000, taskEndMs(task, nowMs));
  const left = Math.max(0, (start - timelineStartMs) * pxPerMs);
  return { left, right: left + Math.max(MIN_BAR_WIDTH, (end - start) * pxPerMs) };
}

/**
 * Collapse bursts of tiny bars into cluster chips.
 *
 * At coarse zooms a run of sub-minute tasks renders as an unreadable smear of
 * `MIN_BAR_WIDTH` slivers. A run of ≥ CLUSTER_MIN_TASKS bars that are each
 * under CLUSTER_MAX_BAR_PX and near-contiguous becomes one chip; clicking it
 * zooms into the burst's span, where the tasks resolve individually.
 */
function clusterItems(
  ordered: TimelineTask[],
  nowMs: number,
  timelineStartMs: number,
  pxPerMs: number,
): RowItem[] {
  const items: RowItem[] = [];
  let run: { task: TimelineTask; left: number; right: number }[] = [];

  const flushRun = () => {
    if (run.length >= CLUSTER_MIN_TASKS) {
      const first = run[0];
      const left = first.left;
      const right = Math.max(run[run.length - 1].right, left + CLUSTER_MIN_WIDTH_PX);
      items.push({
        kind: "cluster",
        id: `cluster:${first.task.id}:${run.length}`,
        tasks: run.map((r) => r.task),
        left,
        right,
        startMs: new Date(first.task.createdAt).getTime(),
        endMs: Math.max(...run.map((r) => taskEndMs(r.task, nowMs))),
      });
    } else {
      for (const r of run) {
        items.push({ kind: "task", id: r.task.id, task: r.task, left: r.left, right: r.right });
      }
    }
    run = [];
  };

  for (const task of ordered) {
    const box = barBox(task, nowMs, timelineStartMs, pxPerMs);
    const tiny = box.right - box.left <= CLUSTER_MAX_BAR_PX;
    const runRight = run.length > 0 ? run[run.length - 1].right : null;
    const contiguous = runRight !== null && box.left - runRight <= CLUSTER_GAP_PX;
    if (tiny && (run.length === 0 || contiguous)) {
      run.push({ task, ...box });
      continue;
    }
    flushRun();
    if (tiny) {
      run.push({ task, ...box });
    } else {
      items.push({ kind: "task", id: task.id, task, left: box.left, right: box.right });
    }
  }
  flushRun();
  return items;
}

/**
 * Lay lanes out into stacked rows.
 *
 * Concurrency is *visual*, not temporal: two items share a row only when their
 * rendered boxes clear each other by `BAR_GAP_PX`. A 2-second task and a
 * 2-hour task both occupy at least `MIN_BAR_WIDTH`, so packing on wall-clock
 * intervals alone would still paint them on top of one another. That makes the
 * layout zoom-dependent — it must be recomputed whenever `pxPerMs` changes.
 *
 * Rows are filled greedily in start order (first row that fits), which is
 * optimal for interval-graph colouring, so a lane never grows taller than its
 * true peak concurrency.
 */
function layoutLanes(
  lanes: Lane[],
  nowMs: number,
  timelineStartMs: number,
  pxPerMs: number,
  startTop: number,
): TimelineLayout {
  const geometry = new Map<string, TaskGeometry>();
  const laneLayouts: LaneLayout[] = [];
  let top = startTop;

  for (const lane of lanes) {
    const ordered = [...lane.tasks].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    const laneItems = clusterItems(ordered, nowMs, timelineStartMs, pxPerMs);

    const rows: RowItem[][] = [];
    const rowEnds: number[] = [];

    for (const item of laneItems) {
      let rowIndex = rowEnds.findIndex((end) => item.left >= end + BAR_GAP_PX);
      if (rowIndex === -1) {
        rowIndex = rows.length < MAX_ROWS_PER_LANE ? rows.length : rows.length - 1;
      }
      if (!rows[rowIndex]) {
        rows[rowIndex] = [];
        rowEnds[rowIndex] = item.right;
      }
      rows[rowIndex].push(item);
      rowEnds[rowIndex] = Math.max(rowEnds[rowIndex], item.right);

      const centerY = top + rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2;
      if (item.kind === "task") {
        geometry.set(item.task.id, { left: item.left, right: item.right, centerY });
      } else {
        // Clustered tasks all anchor connectors at the chip's box.
        for (const task of item.tasks) {
          geometry.set(task.id, { left: item.left, right: item.right, centerY });
        }
      }
    }

    const height = Math.max(1, rows.length) * ROW_HEIGHT;
    laneLayouts.push({ lane, rows, top, height });
    top += height;
  }

  return { laneLayouts, geometry, contentHeight: top };
}

/**
 * Dotted parent→child connector. Anchored at the parent's right edge and the
 * child's left edge with horizontal bezier handles, so the curve reads as a
 * flow even when the child starts before the parent's bar ends (re-parented or
 * clock-skewed rows) and the path has to double back.
 */
function connectorPath(from: TaskGeometry, to: TaskGeometry): string {
  const sx = from.right;
  const sy = from.centerY;
  const tx = to.left;
  const ty = to.centerY;
  const handle = Math.max(24, Math.abs(tx - sx) * 0.3);
  return `M ${sx} ${sy} C ${sx + handle} ${sy}, ${tx - handle} ${ty}, ${tx} ${ty}`;
}

function LaneLabel({ lane, height }: { lane: Lane; height: number }) {
  return (
    <div className="flex min-w-0 items-center gap-2 border-b px-3" style={{ height }}>
      <AgentAvatar
        agentId={lane.isAgent ? lane.id : null}
        agentName={lane.name}
        size="sm"
        className="shrink-0"
      />
      <div className="min-w-0">
        {lane.isAgent ? (
          <Link
            to={`/agents/${lane.id}`}
            className="block truncate text-xs font-medium hover:text-primary hover:underline"
          >
            {lane.name}
          </Link>
        ) : (
          <div className="truncate text-xs font-medium">{lane.name}</div>
        )}
        <div className="truncate text-[10px] text-muted-foreground">
          {lane.isLead ? "Lead" : lane.role || `${lane.tasks.length} tasks`}
        </div>
      </div>
    </div>
  );
}

function TimelineIconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip delayDuration={300}>
      {/* Span wrapper: a disabled button is pointer-events-none, and the
          tooltip must still explain why the control is unavailable. */}
      <TooltipTrigger asChild>
        <span className={cn("inline-flex", disabled && "cursor-not-allowed")}>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={onClick}
            disabled={disabled}
            aria-label={label}
          >
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

export function AgentActivityTimeline() {
  const navigate = useNavigate();
  const [nowMs, setNowMs] = useState(Date.now());
  // Continuous zoom: the window is any ms value in [30s, 7d], not an index into
  // presets — trackpad zoom glides through it, buttons jump between presets.
  const [windowMs, setWindowMs] = useState(DEFAULT_WINDOW_MS);
  const [live, setLive] = useState(true);
  const [historyTasks, setHistoryTasks] = useState<AgentTask[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [hasMoreHistory, setHasMoreHistory] = useState(true);
  const [viewportWidth, setViewportWidth] = useState(MIN_VIEWPORT_WIDTH);
  const [hoveredTaskId, setHoveredTaskId] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const laneLabelsRef = useRef<HTMLDivElement | null>(null);
  const nowLineRef = useRef<HTMLDivElement | null>(null);

  const liveLookbackMs = Math.max(windowMs, 24 * 60 * 60 * 1000);
  const createdAfter = useMemo(() => {
    const bucketNow = Math.floor(nowMs / CREATED_AFTER_BUCKET_MS) * CREATED_AFTER_BUCKET_MS;
    return new Date(bucketNow - liveLookbackMs).toISOString();
  }, [liveLookbackMs, nowMs]);

  const agentsQ = useAgents(false);
  const liveTasksQ = useTasks(
    {
      createdAfter,
      limit: 1200,
      orderBy: "createdAt",
    },
    // `createdAfter` still rolls forward every bucket. Serve the old rows until
    // the new key lands so the chart never blinks back to a spinner.
    { keepPreviousData: true },
  );

  // Deep zoom folds the live drift more often so growing bars step less; the
  // ceiling keeps coarse zooms cheap (each tick is a full layout pass).
  const nowTickMs = Math.max(1_000, Math.min(NOW_TICK_MS, windowMs / 6));
  useEffect(() => {
    const interval = window.setInterval(() => setNowMs(Date.now()), nowTickMs);
    return () => window.clearInterval(interval);
  }, [nowTickMs]);

  // (Viewport tracking lives in `setScrollerNode` below: the scroller doesn't
  // exist on the first, loading render, so a mount-once effect never sees it.)

  const liveTasks = liveTasksQ.data?.tasks ?? [];
  // `allTasks` stays unfiltered: the history cursor pages over what the API
  // actually returns. Filter it and a page of queue-state tasks would leave the
  // cursor unmoved, re-requesting the same page forever.
  const allTasks = useMemo(() => mergeTasks(historyTasks, liveTasks), [historyTasks, liveTasks]);
  const visibleTasks = useMemo(
    () => allTasks.filter((task) => TIMELINE_STATUSES.has(task.status)),
    [allTasks],
  );
  const agents = (agentsQ.data ?? []) as AgentWithTasks[];
  const lanes = useMemo(() => buildLanes(agents, visibleTasks), [agents, visibleTasks]);
  // Idle agents collapse into one accordion row — every agent stays reachable
  // without idle lanes eating half the viewport.
  const activeLanes = useMemo(() => lanes.filter((lane) => lane.tasks.length > 0), [lanes]);
  const idleLanes = useMemo(() => lanes.filter((lane) => lane.tasks.length === 0), [lanes]);
  const [showIdle, setShowIdle] = useState(false);

  useEffect(() => {
    if (allTasks.length === 0) return;
    const oldest = allTasks[0]?.createdAt;
    if (oldest && !historyCursor) setHistoryCursor(oldest);
  }, [allTasks, historyCursor]);

  // Extent follows the bars that are actually drawn, not the raw feed.
  const minTaskMs = visibleTasks[0]
    ? new Date(visibleTasks[0].createdAt).getTime()
    : nowMs - liveLookbackMs;
  const timelineStartMs = Math.min(minTaskMs, nowMs - windowMs);
  const timelineEndMs = Math.max(
    nowMs + LIVE_PADDING_MS,
    ...visibleTasks.map((task) => taskEndMs(task, nowMs) + LIVE_PADDING_MS),
  );
  const pxPerMs = viewportWidth / windowMs;
  const timelineWidth = Math.max(viewportWidth, (timelineEndMs - timelineStartMs) * pxPerMs);
  const { laneLayouts, geometry, contentHeight, idleSummaryTop, activeLaneCount } = useMemo(() => {
    const active = layoutLanes(activeLanes, nowMs, timelineStartMs, pxPerMs, HEADER_HEIGHT);
    const summaryHeight = idleLanes.length > 0 ? IDLE_SUMMARY_HEIGHT : 0;
    const idleTop = active.contentHeight + summaryHeight;
    const idle = showIdle ? layoutLanes(idleLanes, nowMs, timelineStartMs, pxPerMs, idleTop) : null;
    return {
      laneLayouts: idle ? [...active.laneLayouts, ...idle.laneLayouts] : active.laneLayouts,
      geometry: active.geometry,
      idleSummaryTop: active.contentHeight,
      activeLaneCount: active.laneLayouts.length,
      contentHeight: Math.max(160, idle ? idle.contentHeight : idleTop),
    };
  }, [activeLanes, idleLanes, showIdle, nowMs, timelineStartMs, pxPerMs]);

  // Parent→children adjacency for the hover connectors. Built over every loaded
  // task, not just the hovered lane, so a link survives cross-agent delegation.
  const childrenByParent = useMemo(() => {
    const map = new Map<string, TimelineTask[]>();
    for (const task of visibleTasks) {
      if (!task.parentTaskId) continue;
      const siblings = map.get(task.parentTaskId) ?? [];
      siblings.push(task);
      map.set(task.parentTaskId, siblings);
    }
    return map;
  }, [visibleTasks]);

  const taskById = useMemo(
    () => new Map(visibleTasks.map((task) => [task.id, task])),
    [visibleTasks],
  );

  // Edges to draw for the hovered bar: its parent, and each of its children.
  // Endpoints missing from `geometry` (task outside the loaded window) are dropped.
  const hoveredEdges = useMemo(() => {
    if (!hoveredTaskId) return [];
    const edges: { id: string; from: TaskGeometry; to: TaskGeometry }[] = [];
    const hovered = taskById.get(hoveredTaskId);
    const hoveredGeom = geometry.get(hoveredTaskId);
    if (!hovered || !hoveredGeom) return edges;

    const parentGeom = hovered.parentTaskId ? geometry.get(hovered.parentTaskId) : undefined;
    if (parentGeom) {
      edges.push({
        id: `${hovered.parentTaskId}->${hovered.id}`,
        from: parentGeom,
        to: hoveredGeom,
      });
    }
    for (const child of childrenByParent.get(hoveredTaskId) ?? []) {
      const childGeom = geometry.get(child.id);
      if (childGeom)
        edges.push({ id: `${hovered.id}->${child.id}`, from: hoveredGeom, to: childGeom });
    }
    return edges;
  }, [childrenByParent, geometry, hoveredTaskId, taskById]);

  // Bars that stay at full opacity while hovering: the hovered task and its kin.
  // `null` means "dim nothing" — hovering a task with no drawn connectors must
  // not grey out the whole chart for no reason.
  const relatedIds = useMemo(() => {
    if (!hoveredTaskId || hoveredEdges.length === 0) return null;
    const ids = new Set<string>([hoveredTaskId]);
    const hovered = taskById.get(hoveredTaskId);
    if (hovered?.parentTaskId) ids.add(hovered.parentTaskId);
    for (const child of childrenByParent.get(hoveredTaskId) ?? []) ids.add(child.id);
    return ids;
  }, [childrenByParent, hoveredEdges.length, hoveredTaskId, taskById]);

  // Axis labels are virtualized to the scrolled-to viewport (± one viewport of
  // buffer). `scrollBucket` advances every half viewport, so scrolling only
  // re-renders labels when a new region comes into range.
  const [scrollBucket, setScrollBucket] = useState(0);
  const intervalMs = tickIntervalMs(windowMs);
  const intervalPx = intervalMs * pxPerMs;
  // Shared by axis-label AND bar virtualization: the scrolled-to region plus
  // one viewport of buffer each side.
  const viewLeftPx = Math.max(0, (scrollBucket * viewportWidth) / 2 - viewportWidth);
  const viewRightPx = (scrollBucket * viewportWidth) / 2 + 2 * viewportWidth;
  const ticks = useMemo(() => {
    return buildTicks(
      timelineStartMs + viewLeftPx / pxPerMs,
      Math.min(timelineEndMs, timelineStartMs + viewRightPx / pxPerMs),
      intervalMs,
    );
  }, [viewLeftPx, viewRightPx, timelineStartMs, timelineEndMs, pxPerMs, intervalMs]);

  // Lane gridlines are a repeating gradient, not DOM ticks — at the 30s zoom a
  // day of content is ~17k tick positions and per-lane divs would hang the tab.
  // Phase-shift the pattern so lines land on the absolute tick grid.
  const gridPhasePx =
    ((Math.ceil(timelineStartMs / intervalMs) * intervalMs - timelineStartMs) * pxPerMs) %
    intervalPx;
  const laneGridStyle = {
    backgroundImage: `repeating-linear-gradient(to right, color-mix(in srgb, var(--color-border) 50%, transparent) 0 1px, transparent 1px ${intervalPx}px)`,
    backgroundPositionX: `${gridPhasePx}px`,
  } as const;

  const loadOlder = useCallback(async () => {
    if (isLoadingHistory || !hasMoreHistory || !historyCursor) return;
    setIsLoadingHistory(true);
    try {
      const result = await api.fetchTasks({
        createdBefore: historyCursor,
        orderBy: "createdAt",
        limit: PAGE_SIZE,
      });
      setHistoryTasks((prev) => mergeTasks(prev, result.tasks));
      if (result.tasks.length > 0) {
        const oldest = result.tasks.reduce((min, task) =>
          task.createdAt < min.createdAt ? task : min,
        );
        setHistoryCursor(oldest.createdAt);
      }
      if (result.tasks.length < PAGE_SIZE) setHasMoreHistory(false);
    } finally {
      setIsLoadingHistory(false);
    }
  }, [hasMoreHistory, historyCursor, isLoadingHistory]);

  // Values the per-frame drift loop reads without re-subscribing.
  const pxPerMsRef = useRef(pxPerMs);
  pxPerMsRef.current = pxPerMs;
  const nowMsRef = useRef(nowMs);
  nowMsRef.current = nowMs;
  const timelineStartRef = useRef(timelineStartMs);
  timelineStartRef.current = timelineStartMs;
  // Last position we wrote ourselves, so the scroll handler can tell our echo
  // from real user input. Value-compare, not a consume-once flag: our writes
  // and user scroll events interleave unpredictably, and a boolean flag
  // consumed by the wrong event made user pans invisible (scroll felt dead).
  const lastProgrammaticLeftRef = useRef<number | null>(null);
  const liveRef = useRef(live);
  liveRef.current = live;

  /** Where live-follow wants scrollLeft: now-line near the right edge. */
  const liveScrollTarget = useCallback((node: HTMLDivElement, nowX: number) => {
    const max = node.scrollWidth - node.clientWidth;
    return Math.max(0, Math.min(nowX - node.clientWidth + LIVE_EDGE_GAP_PX, max));
  }, []);

  /**
   * Live follow, drift-transform architecture (see
   * thoughts/taras/research/2026-07-09-timeline-smooth-scroll-options.md):
   * between data ticks the content wrapper glides left via a GPU transform —
   * scrollLeft is NEVER written per frame, so native scrolling stays fully
   * responsive and there is no per-frame write for a user pan to fight.
   */
  useEffect(() => {
    if (!live) return;
    let raf = 0;
    const step = () => {
      const drift = Math.max(0, (Date.now() - nowMsRef.current) * pxPerMsRef.current);
      if (timelineRef.current) {
        timelineRef.current.style.transform = `translateX(${-drift}px)`;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      if (timelineRef.current) timelineRef.current.style.transform = "";
    };
  }, [live]);

  // On each data tick while live, fold the accumulated drift into one real
  // scrollLeft write and reset the transform — atomically, before paint.
  useLayoutEffect(() => {
    if (!live) return;
    const node = scrollerRef.current;
    if (!node) return;
    const nowX = (nowMs - timelineStartMs) * pxPerMs;
    const target = liveScrollTarget(node, nowX);
    lastProgrammaticLeftRef.current = target;
    node.scrollLeft = target;
    if (timelineRef.current) timelineRef.current.style.transform = "translateX(0px)";
  }, [live, nowMs, pxPerMs, timelineStartMs, liveScrollTarget]);

  /** Leave live-follow, folding any in-flight drift so the view doesn't jump. */
  const pauseLive = useCallback(() => {
    if (!liveRef.current) return;
    const node = scrollerRef.current;
    const drift = Math.max(0, (Date.now() - nowMsRef.current) * pxPerMsRef.current);
    if (node && drift > 0) {
      const folded = node.scrollLeft + drift;
      lastProgrammaticLeftRef.current = folded;
      node.scrollLeft = folded;
    }
    if (timelineRef.current) timelineRef.current.style.transform = "";
    setLive(false);
  }, []);

  // After a zoom while paused, restore the timestamp that sat under the anchor
  // point (cursor for wheel, viewport centre for buttons) to the same pixel.
  // Without it, zoom pivots on the scroll origin and the content the user was
  // looking at flies off-screen. Must be layout-effect: a paint at the old
  // scrollLeft flickers. While live, the fold effect owns the position instead.
  const pendingAnchorRef = useRef<{ timeMs: number; offsetPx: number } | null>(null);
  useLayoutEffect(() => {
    const node = scrollerRef.current;
    const anchor = pendingAnchorRef.current;
    if (!node || !anchor) return;
    pendingAnchorRef.current = null;
    const left = (anchor.timeMs - timelineStartMs) * pxPerMs - anchor.offsetPx;
    lastProgrammaticLeftRef.current = left;
    node.scrollLeft = left;
  }, [pxPerMs, timelineStartMs]);

  // Zooming deliberately does NOT touch `live` — like transcript follow, only
  // the user scrolling away breaks the link. Live zoom re-pins via the fold;
  // paused zoom pivots around the anchor.
  const zoomToWindow = useCallback(
    (nextWindowMs: number, anchorClientX?: number) => {
      const node = scrollerRef.current;
      if (node && !liveRef.current) {
        const offsetPx =
          anchorClientX !== undefined
            ? anchorClientX - node.getBoundingClientRect().left
            : node.clientWidth / 2;
        pendingAnchorRef.current = {
          timeMs: timelineStartMs + (node.scrollLeft + offsetPx) / pxPerMs,
          offsetPx,
        };
      }
      setWindowMs(clampWindowMs(nextWindowMs));
    },
    [pxPerMs, timelineStartMs],
  );
  const zoomToWindowRef = useRef(zoomToWindow);
  zoomToWindowRef.current = zoomToWindow;
  const windowMsRef = useRef(windowMs);
  windowMsRef.current = windowMs;

  /** Cluster chip click: zoom until the burst's tasks resolve individually. */
  const zoomToRange = useCallback(
    (startMs: number, endMs: number) => {
      pauseLive();
      const node = scrollerRef.current;
      const spanMs = Math.max(endMs - startMs, MIN_WINDOW_MS / 2);
      const nextWindow = clampWindowMs(spanMs * 1.6);
      if (node) {
        pendingAnchorRef.current = {
          timeMs: (startMs + endMs) / 2,
          offsetPx: node.clientWidth / 2,
        };
      }
      setWindowMs(nextWindow);
    },
    [pauseLive],
  );

  const handleScroll = useCallback(() => {
    const node = scrollerRef.current;
    if (!node) return;
    // Keep the lane labels pinned to their rows on vertical scroll. Done as a
    // transform on a ref, not state — this fires on every scroll frame.
    if (laneLabelsRef.current) {
      laneLabelsRef.current.style.transform = `translateY(${-node.scrollTop}px)`;
    }
    // Track which region is in view for axis/bar virtualization. Same-value
    // sets bail out of re-rendering, so this is cheap per scroll frame.
    setScrollBucket(Math.floor(node.scrollLeft / Math.max(1, node.clientWidth / 2)));
    // Our own write echoing back — not user input.
    if (
      lastProgrammaticLeftRef.current !== null &&
      Math.abs(node.scrollLeft - lastProgrammaticLeftRef.current) < 1
    ) {
      return;
    }
    if (node.scrollLeft < 180) void loadOlder();
    if (liveRef.current) {
      // Backup follow-break for scrollbar drags (wheel pans are caught at the
      // input event). Deadband so trackpad jitter doesn't flap the toggle.
      const nowX = (Date.now() - timelineStartRef.current) * pxPerMsRef.current;
      if (Math.abs(liveScrollTarget(node, nowX) - node.scrollLeft) > FOLLOW_BREAK_PX) {
        pauseLive();
      }
    }
  }, [liveScrollTarget, loadOlder, pauseLive]);

  // Wheel zoom needs a NATIVE non-passive listener: React attaches `onWheel`
  // passively, so preventDefault() is ignored there and ctrl+wheel (macOS
  // pinch) zooms the page instead of the timeline. Zoom is CONTINUOUS —
  // exponential in accumulated delta, applied once per frame — so a trackpad
  // pinch glides through window sizes instead of stepping between presets.
  const wheelAccumRef = useRef(0);
  const wheelRafRef = useRef(0);
  const pauseLiveRef = useRef(pauseLive);
  pauseLiveRef.current = pauseLive;
  // Callback ref, not an effect: the scroller doesn't exist on the first
  // (loading) render, so a mount-once effect would never find it to attach.
  // The viewport ResizeObserver lives here for the same reason.
  const wheelCleanupRef = useRef<(() => void) | null>(null);
  const setScrollerNode = useCallback((node: HTMLDivElement | null) => {
    wheelCleanupRef.current?.();
    wheelCleanupRef.current = null;
    scrollerRef.current = node;
    if (!node) return;
    const onWheel = (event: globalThis.WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        wheelAccumRef.current += event.deltaY;
        const anchorX = event.clientX;
        if (wheelRafRef.current) return;
        wheelRafRef.current = requestAnimationFrame(() => {
          wheelRafRef.current = 0;
          const factor = 2 ** (wheelAccumRef.current / 200);
          wheelAccumRef.current = 0;
          zoomToWindowRef.current(windowMsRef.current * factor, anchorX);
        });
        return;
      }
      // A horizontal pan is the user grabbing the timeline — break follow at
      // the INPUT, before follow logic can reassert the position. Waiting for
      // the scroll event loses that race and scrolling feels dead.
      if (liveRef.current && Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        pauseLiveRef.current();
      }
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setViewportWidth(Math.max(MIN_VIEWPORT_WIDTH, entry.contentRect.width));
    });
    observer.observe(node);
    wheelCleanupRef.current = () => {
      node.removeEventListener("wheel", onWheel);
      observer.disconnect();
      if (wheelRafRef.current) cancelAnimationFrame(wheelRafRef.current);
    };
  }, []);

  const backToLive = useCallback(() => setLive(true), []);

  // Preset stepping for the zoom buttons over the continuous window.
  const nextPresetIn = [...ZOOM_LEVELS].reverse().find((z) => z.ms < windowMs * 0.99);
  const nextPresetOut = ZOOM_LEVELS.find((z) => z.ms > windowMs * 1.01);

  // Only the *first* load is a spinner. Once data exists, a refetch (or a new
  // `createdAfter` bucket) keeps the chart on screen — `keepPreviousData` means
  // `isLoading` no longer implies "nothing to draw".
  if (!liveTasksQ.data && (agentsQ.isLoading || liveTasksQ.isLoading)) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg border bg-card">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (visibleTasks.length === 0) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg border bg-card">
        <EmptyState
          icon={Clock}
          title="No task activity yet"
          description="Tasks appear here once an agent starts running them."
        />
      </div>
    );
  }

  return (
    <section className="flex h-full flex-col overflow-hidden rounded-lg border bg-card">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Swarm activity timeline</h2>
          <p className="text-xs text-muted-foreground">
            {visibleTasks.length.toLocaleString()} tasks · visible window{" "}
            {formatWindowLabel(windowMs)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            variant={live ? "secondary" : "outline"}
            size="sm"
            onClick={live ? () => setLive(false) : backToLive}
            className="h-8"
            title={live ? "Pause live updates" : "Follow live activity"}
          >
            {live ? (
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-status-active opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-status-active" />
              </span>
            ) : (
              <Radio className="h-3.5 w-3.5" />
            )}
            {live ? "Live" : "Back to live"}
          </Button>
          <TimelineIconButton
            label={nextPresetIn ? `Zoom in (${nextPresetIn.label} window)` : "Zoom in"}
            onClick={() => nextPresetIn && zoomToWindow(nextPresetIn.ms)}
            disabled={!nextPresetIn}
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </TimelineIconButton>
          <TimelineIconButton
            label={nextPresetOut ? `Zoom out (${nextPresetOut.label} window)` : "Zoom out"}
            onClick={() => nextPresetOut && zoomToWindow(nextPresetOut.ms)}
            disabled={!nextPresetOut}
          >
            <ZoomOut className="h-3.5 w-3.5" />
          </TimelineIconButton>
          <TimelineIconButton
            label={`Reset zoom to ${ZOOM_LEVELS[DEFAULT_ZOOM_INDEX].label}`}
            onClick={() => zoomToWindow(DEFAULT_WINDOW_MS)}
            disabled={Math.abs(windowMs - DEFAULT_WINDOW_MS) < DEFAULT_WINDOW_MS * 0.01}
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </TimelineIconButton>
          <TimelineIconButton
            label={
              isLoadingHistory
                ? "Loading older activity…"
                : hasMoreHistory
                  ? "Load older activity"
                  : "No older activity"
            }
            onClick={() => void loadOlder()}
            disabled={isLoadingHistory || !hasMoreHistory}
          >
            {isLoadingHistory ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <History className="h-3.5 w-3.5" />
            )}
          </TimelineIconButton>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div
          className="shrink-0 overflow-hidden border-r bg-muted/35"
          style={{ width: LABEL_WIDTH, paddingTop: HEADER_HEIGHT }}
        >
          <div ref={laneLabelsRef}>
            {laneLayouts.slice(0, activeLaneCount).map((laneLayout) => (
              <LaneLabel
                key={laneLayout.lane.id}
                lane={laneLayout.lane}
                height={laneLayout.height}
              />
            ))}
            {idleLanes.length > 0 ? (
              <button
                type="button"
                className="flex w-full cursor-pointer items-center gap-1.5 border-b bg-muted/60 px-3 text-left text-[11px] text-muted-foreground hover:text-foreground"
                style={{ height: IDLE_SUMMARY_HEIGHT }}
                onClick={() => setShowIdle((current) => !current)}
                aria-expanded={showIdle}
              >
                {showIdle ? (
                  <ChevronDown className="h-3 w-3 shrink-0" />
                ) : (
                  <ChevronRight className="h-3 w-3 shrink-0" />
                )}
                {idleLanes.length} idle {idleLanes.length === 1 ? "agent" : "agents"}
              </button>
            ) : null}
            {laneLayouts.slice(activeLaneCount).map((laneLayout) => (
              <LaneLabel
                key={laneLayout.lane.id}
                lane={laneLayout.lane}
                height={laneLayout.height}
              />
            ))}
          </div>
        </div>

        <div
          ref={setScrollerNode}
          className="min-w-0 flex-1 overflow-auto overscroll-x-contain"
          onScroll={handleScroll}
        >
          <div
            ref={timelineRef}
            className="relative"
            style={{ width: timelineWidth, height: contentHeight }}
          >
            <div className="sticky top-0 z-20 h-10 border-b bg-card/95 backdrop-blur">
              {ticks.map((tick) => {
                const x = (tick - timelineStartMs) * pxPerMs;
                return (
                  <div
                    key={tick}
                    className="absolute top-0 h-full border-l border-border/80 pl-2 pt-2 text-[10px] text-muted-foreground"
                    style={{ left: x }}
                  >
                    {formatAxisLabel(tick, windowMs)}
                  </div>
                );
              })}
              {/* While live, the follow loop moves this via ref.style.left
                  every frame; the render-time value is the paused position. */}
              <div
                ref={nowLineRef}
                className="absolute top-0 h-full border-l border-primary"
                style={{ left: (nowMs - timelineStartMs) * pxPerMs }}
              >
                <div className="ml-1 mt-1 w-fit rounded bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">
                  now
                </div>
              </div>
            </div>

            {idleLanes.length > 0 ? (
              <div
                className="absolute left-0 right-0 border-b bg-muted/40"
                style={{ top: idleSummaryTop, height: IDLE_SUMMARY_HEIGHT }}
              />
            ) : null}

            {laneLayouts.map(({ lane, rows, top, height }) => (
              <div
                key={lane.id}
                className="absolute left-0 right-0 border-b bg-background"
                style={{ top, height, ...laneGridStyle }}
              >
                {rows.map((row, rowIndex) =>
                  // Virtualized: bars outside the scrolled-to region (± one
                  // viewport) skip the DOM entirely.
                  row.map((item) => {
                    if (item.right < viewLeftPx || item.left > viewRightPx) return null;
                    const rowTop = rowIndex * ROW_HEIGHT + (ROW_HEIGHT - BAR_HEIGHT) / 2;
                    if (item.kind === "cluster") {
                      return (
                        <Tooltip key={item.id} delayDuration={120}>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              className="absolute cursor-zoom-in rounded border border-border bg-muted px-1.5 text-left text-[10px] font-semibold text-muted-foreground shadow-sm hover:bg-accent hover:text-accent-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                              style={{
                                left: item.left,
                                width: item.right - item.left,
                                top: rowTop,
                                height: BAR_HEIGHT,
                              }}
                              onClick={() => zoomToRange(item.startMs, item.endMs)}
                            >
                              <span className="block truncate leading-[22px]">
                                ×{item.tasks.length}
                              </span>
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="top" align="start">
                            <div className="text-xs font-medium">
                              {item.tasks.length} tasks in a burst
                            </div>
                            <div className="text-[10px] text-background/70">
                              {formatTime(item.startMs)} – {formatTime(item.endMs)} · click to zoom
                              in
                            </div>
                          </TooltipContent>
                        </Tooltip>
                      );
                    }
                    const task = item.task;
                    const start = new Date(task.createdAt).getTime();
                    const end = Math.max(start + 1000, taskEndMs(task, nowMs));
                    const left = item.left;
                    const width = item.right - item.left;
                    const duration = formatDurationMs(end - start);
                    const dimmed = relatedIds !== null && !relatedIds.has(task.id);
                    return (
                      <Tooltip key={task.id} delayDuration={120}>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            className={cn(
                              "absolute rounded border px-2 text-left text-[10px] font-medium shadow-sm transition-opacity hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-ring",
                              statusBarClass(task.status),
                              // Running tasks get a sweeping highlight so "live
                              // right now" reads at a glance.
                              task.status === "in_progress" && "shimmer-bar",
                              dimmed && "opacity-30",
                            )}
                            style={{
                              left,
                              width,
                              top: rowTop,
                              height: BAR_HEIGHT,
                            }}
                            onClick={() => navigate(`/tasks/${task.id}`)}
                            onMouseEnter={() => setHoveredTaskId(task.id)}
                            onMouseLeave={() =>
                              setHoveredTaskId((current) => (current === task.id ? null : current))
                            }
                            onFocus={() => setHoveredTaskId(task.id)}
                            onBlur={() =>
                              setHoveredTaskId((current) => (current === task.id ? null : current))
                            }
                          >
                            <span className="block truncate leading-[22px]">{taskTitle(task)}</span>
                          </button>
                        </TooltipTrigger>
                        {/* Tooltip surface is inverted (`bg-foreground
                            text-background`), so every token in here is keyed to
                            `background`, not `foreground`. A `StatusBadge` would
                            wash out for the same reason — a saturated dot reads
                            on both themes. */}
                        <TooltipContent side="top" align="start" className="max-w-80">
                          <div className="space-y-2">
                            <div className="space-y-1">
                              <div className="line-clamp-3 text-xs font-medium">
                                {taskTitle(task)}
                              </div>
                              <div className="flex items-center gap-1.5 text-[10px]">
                                <span
                                  className={cn(
                                    "h-2 w-2 shrink-0 rounded-full",
                                    statusDotClass(task.status),
                                  )}
                                />
                                <span className="font-medium uppercase tracking-wide">
                                  {task.status.replace(/_/g, " ")}
                                </span>
                                <span className="text-background/60">·</span>
                                <span className="text-background/70">{duration}</span>
                              </div>
                            </div>
                            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] text-background/70">
                              <span>Started</span>
                              <span className="text-right text-background">
                                {formatTime(start)}
                              </span>
                              <span>Ended</span>
                              <span className="text-right text-background">
                                {task.finishedAt ? formatTime(end) : "Live"}
                              </span>
                              <span>Tokens</span>
                              <span className="text-right text-background">
                                {task.peakContextTokens
                                  ? formatTokens(task.peakContextTokens)
                                  : "—"}
                              </span>
                              <span>Cost</span>
                              <span className="text-right text-background">
                                {formatCost(task.totalCostUsd, { precision: "compact" })}
                              </span>
                            </div>
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    );
                  }),
                )}
              </div>
            ))}

            {/* Parent→child connectors for the hovered bar. Sits above the lane
                backgrounds but below the sticky axis, and never eats pointer
                events — otherwise a curve crossing a bar would kill its hover. */}
            {hoveredEdges.length > 0 ? (
              <svg
                className="pointer-events-none absolute left-0 top-0 z-10 overflow-visible text-primary"
                width={timelineWidth}
                height={contentHeight}
                aria-hidden="true"
              >
                <title>Related task connections</title>
                {hoveredEdges.map((edge) => (
                  <g key={edge.id}>
                    <path
                      d={connectorPath(edge.from, edge.to)}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.5}
                      strokeDasharray="3 3"
                      strokeLinecap="round"
                    />
                    <circle
                      cx={edge.from.right}
                      cy={edge.from.centerY}
                      r={2.5}
                      fill="currentColor"
                    />
                    <circle cx={edge.to.left} cy={edge.to.centerY} r={2.5} fill="currentColor" />
                  </g>
                ))}
              </svg>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
