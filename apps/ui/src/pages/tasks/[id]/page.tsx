import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, PanelRightClose, PanelRightOpen, Pencil, Tag } from "lucide-react";
import {
  type CSSProperties,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import {
  renderTaskCitationSources,
  renderTaskCitations,
  type TaskCitation,
} from "../../../../../../src/utils/task-citations";
import "streamdown/styles.css";
import { useAgents } from "@/api/hooks/use-agents";
import { useSessionCosts } from "@/api/hooks/use-costs";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { useSession, useUpdateSessionTitle } from "@/api/hooks/use-sessions";
import { useSteeringEnabled } from "@/api/hooks/use-stats";
import {
  useRequestComposition,
  useTask,
  useTaskContext,
  useTaskSessionLogs,
  useTaskSteeringMessages,
} from "@/api/hooks/use-tasks";
import { useUsers } from "@/api/hooks/use-users";
import type { AgentTask, AgentTaskStatus, TaskWithLogs } from "@/api/types";
import { useTaskPath } from "@/components/layout/use-task-path";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { AnimatedReveal } from "@/components/shared/animated-reveal";
import { CopyValueButton } from "@/components/shared/copy-value-button";
import { EffortMark } from "@/components/shared/effort-mark";
import { MarkdownView } from "@/components/shared/markdown-view";
import { ModelEffortLabel } from "@/components/shared/model-effort-label";
import { REASONING_EFFORT_LABEL } from "@/components/shared/reasoning-effort-icon";
import {
  CallCompositionContext,
  NO_CALL_COMPOSITIONS,
} from "@/components/shared/request-composition-bar";
import { SessionLogViewer } from "@/components/shared/session-log-viewer";
import { ShowMore } from "@/components/shared/show-more";
import { StatusBadge } from "@/components/shared/status-badge";
import { TaskCitationsSection } from "@/components/shared/task-citations-section";
import { TaskComposer } from "@/components/shared/task-composer";
import { TaskStatusIcon } from "@/components/shared/task-status-icon";
import { TaskTranscript } from "@/components/shared/transcript/task-transcript";
import { buildTranscriptRows } from "@/components/shared/transcript/transcript-rows";
import { TaskFailureHelpDialog } from "@/components/support/task-failure-help-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useLocalToggle } from "@/hooks/use-local-toggle";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { CHAT_COLUMN } from "@/lib/chat-width";
import { formatCost } from "@/lib/cost-format";
import { MAIN_BLEED, MAIN_BLEED_Y, MAIN_GUTTER_X } from "@/lib/main-gutter";
import { modelTierLabel } from "@/lib/model-tiers";
import { compositionCallsOf, deriveCallCompositions } from "@/lib/request-composition";
import { useUsageDetails } from "@/lib/session-log-usage-details";
import { SESSIONS_V2_MIN_VERSION } from "@/lib/sessions-v2";
import { parseStructuredOutput } from "@/lib/structured-output";
import { TERMINAL_STATUSES, taskIsRunning } from "@/lib/task-activity";
import { linkTaskIds } from "@/lib/task-links";
import {
  describeModelResolution,
  taskDisplayEffort,
  taskDisplayModel,
} from "@/lib/task-model-resolution";
import { canSteerTask } from "@/lib/task-steer";
import { taskListTitle } from "@/lib/task-title";
import { cn, formatRelativeTime, sessionDisplayTitle } from "@/lib/utils";
import { normalizeSessionLogs, parseSessionLogs, sumItemCallUsage } from "@/logs-parser";
import { directChildren } from "./spawned-tasks";
import {
  TaskActions,
  TaskActionsMenu,
  TaskFailureCallout,
  TaskPrimaryAction,
  useTaskActions,
} from "./task-actions";
import { TaskDetailsRail, taskRunTime, taskTotalCost } from "./task-details-rail";
import { TaskSourceLine } from "./task-source-line";
import {
  STICKY_BAR_HEIGHT,
  scrollToTop,
  TaskStickyBar,
  useHeroScrolledPast,
} from "./task-sticky-bar";
import { useElementHeight } from "./use-element-height";

/**
 * The narrow layout's tabs: the transcript and the details card. The `?tab=`
 * values predate the labels: Transcript is `logs`.
 */
const TASK_DETAIL_TABS = new Set(["logs", "details"]);

/** The old `files` and `tree` tabs: the details card holds the files and the parent task. */
const LEGACY_TASK_TABS: Record<string, string> = { files: "details", tree: "details" };

/** The focus ring of a narrow tab panel (the panel itself is a Tab stop). */
const PANEL_FOCUS_RING = "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60";

function coerceTaskDetailTab(value: string, fallback: string): string {
  const tab = LEGACY_TASK_TABS[value] ?? value;
  return TASK_DETAIL_TABS.has(tab) ? tab : fallback;
}

/**
 * The narrow layout's first tab, whatever the status: the transcript is the
 * page's main view, as in the wide layout's center column. An expanded app
 * sidebar can push a desktop window into this layout too.
 */
const DEFAULT_TASK_TAB = "logs";

/**
 * The log's views: the transcript (the shared chat renderer, also on the
 * Sessions page) or the raw log with every event. The "..." menu toggles
 * them, and `?log=raw` keeps the pick.
 */
type LogMode = "transcript" | "raw";

/** The rename limit of `PATCH /api/tasks/{id}/title`. */
const TITLE_MAX = 120;

/**
 * Task title as the page heading, at most two lines. A clamped title shows
 * in full in a tooltip. "View full prompt" (the source line) has the whole
 * prompt for keyboard users. With `onRename`, a double-click or the pencil
 * (on hover or focus) opens the rename field.
 */
function TaskHeading({
  title,
  onRename,
  pencilRef,
}: {
  title: string;
  onRename?: () => void;
  /** Shows the pencil. The narrow layout renames from its "..." menu. */
  pencilRef?: RefObject<HTMLButtonElement | null>;
}) {
  const [heading, setHeading] = useState<HTMLHeadingElement | null>(null);
  const [clamped, setClamped] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!heading) return;
    const measure = () => setClamped(heading.scrollHeight > heading.clientHeight + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(heading);
    measure();
    return () => observer.disconnect();
  }, [heading]);
  return (
    <div className="group/title flex min-w-0 items-start gap-1">
      {/* Stays mounted: only `open` follows the clamp. */}
      <Tooltip open={clamped && open} onOpenChange={setOpen}>
        <TooltipTrigger asChild>
          <h1
            // A new title is a new heading, measured again: a 2-line and a
            // 3-line title clamp to the same height, so no resize fires.
            key={title}
            ref={setHeading}
            onDoubleClick={onRename}
            className="line-clamp-2 min-w-0 text-lg font-semibold leading-snug text-balance break-words"
          >
            {title}
          </h1>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="start" className="max-w-lg text-left text-pretty">
          {title}
        </TooltipContent>
      </Tooltip>
      {onRename && pencilRef ? (
        // In at once on hover (anywhere on the header) or focus, out with the
        // linger. A touch screen has no hover: the pencil always shows there.
        <span className="flex shrink-0 opacity-0 transition-opacity delay-50 duration-200 ease-snappy group-hover/title:opacity-100 group-hover/title:delay-0 group-hover/title:duration-0 focus-within:opacity-100 focus-within:delay-0 focus-within:duration-0 pointer-coarse:opacity-100">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                ref={pencilRef}
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label="Rename task"
                onClick={onRename}
                className="text-muted-foreground hover:text-foreground"
              >
                <Pencil className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Rename task</TooltipContent>
          </Tooltip>
        </span>
      ) : null}
    </div>
  );
}

/**
 * The rename field, in the heading's place. Enter or a blur saves, Escape
 * cancels. `onDone(title, refocus)`: the typed title, or null to cancel. A
 * key asks for the focus back (the pencil, or the narrow "..." trigger).
 */
function TaskTitleField({
  current,
  placeholder,
  onDone,
}: {
  /** The title as shown: the saved one, or the prompt's. */
  current: string;
  /** The prompt's title: an empty title shows it again. */
  placeholder: string;
  onDone: (title: string | null, refocus: boolean) => void;
}) {
  const [draft, setDraft] = useState(current);
  const ref = useRef<HTMLInputElement>(null);
  const hintId = useId();
  // An Escape can still blur the field as it goes: end once.
  const ended = useRef(false);
  // An effect, not `autoFocus`. Only the copy that shows takes the focus:
  // both layouts mount a field, and the other layout's copy is hidden.
  useEffect(() => {
    const input = ref.current;
    if (!input || input.getClientRects().length === 0) return;
    input.focus();
    input.select();
  }, []);
  const end = (save: boolean, refocus: boolean) => {
    if (ended.current) return;
    ended.current = true;
    onDone(save ? draft : null, refocus);
  };
  return (
    <>
      <Input
        ref={ref}
        aria-label="Task title"
        aria-describedby={hintId}
        value={draft}
        maxLength={TITLE_MAX}
        autoComplete="off"
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => end(true, false)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key !== "Enter" && event.key !== "Escape") return;
          event.preventDefault();
          end(event.key === "Enter", true);
        }}
        className="-my-[3px] -ml-1.5 h-auto px-1.5 py-0.5 text-lg font-semibold leading-snug md:text-lg"
      />
      <span id={hintId} className="sr-only">
        Enter saves, Escape cancels. An empty title shows the prompt again.
      </span>
    </>
  );
}

/**
 * What a task with no session log waits for, in one line. The hero owns the
 * actions (Cancel, Resume). `draft` is the transient "attachments still
 * uploading" state.
 */
function describeWaiting(
  task: { status: AgentTaskStatus; createdAt: string },
  names: { agent: string | null; offeredTo: string | null },
): string {
  switch (task.status) {
    case "pending":
    case "unassigned":
      return `Waiting for ${names.agent ?? "an agent"} to pick this up. Queued ${formatRelativeTime(task.createdAt)}.`;
    case "offered":
    case "reviewing":
      return `Offered to ${names.offeredTo ?? "an agent"}. Waiting for an answer.`;
    case "backlog":
      return "In the backlog.";
    case "paused":
      return "Paused.";
    case "draft":
      return "Uploading attachments…";
    case "in_progress":
      return "Waiting for the first session log.";
    default:
      return "This task finished without a session log.";
  }
}

/**
 * Task ids in the answer link to their pages, in the same tab, like the
 * spawned task rows. `taskIds` are the ids the page knows.
 */
function StructuredOutputContent({
  raw,
  maxH,
  citations = [],
  taskIds,
}: {
  raw: string;
  maxH: string;
  citations?: TaskCitation[];
  taskIds: readonly string[];
}) {
  const taskLinks = new Set(taskIds.map((taskId) => `/tasks/${taskId}`));
  const structured = parseStructuredOutput(raw);
  if (!structured) {
    return (
      <div className={`text-sm leading-relaxed overflow-auto text-foreground ${maxH}`}>
        <MarkdownView
          text={linkTaskIds(renderTaskCitations(raw, citations, "markdown"), taskIds)}
          sameTabHrefs={taskLinks}
        />
      </div>
    );
  }
  return (
    <div className={`space-y-3 overflow-auto ${maxH}`}>
      {structured.summary && (
        <div>
          <span className="text-meta font-semibold text-muted-foreground uppercase tracking-wider">
            Summary
          </span>
          <div className="mt-1 text-sm leading-relaxed text-foreground">
            <MarkdownView
              text={linkTaskIds(
                renderTaskCitations(structured.summary, citations, "markdown", false),
                taskIds,
              )}
              sameTabHrefs={taskLinks}
            />
          </div>
        </div>
      )}
      {structured.output && (
        <div>
          <span className="text-meta font-semibold text-muted-foreground uppercase tracking-wider">
            Output
          </span>
          <div className="mt-1 text-sm leading-relaxed text-foreground">
            <MarkdownView
              text={linkTaskIds(
                renderTaskCitations(structured.output, citations, "markdown", false),
                taskIds,
              )}
              sameTabHrefs={taskLinks}
            />
          </div>
        </div>
      )}
      {citations.length > 0 && (
        <MarkdownView text={renderTaskCitationSources(raw, citations, "markdown")} />
      )}
    </div>
  );
}

/**
 * Focuses the message box that shows. Both layouts pin it under their
 * scroller, so it is always in view.
 */
function focusVisibleComposer(wideBox: HTMLElement | null, narrowBar: HTMLElement | null) {
  const shown = (element: HTMLElement | null) => !!element && element.getClientRects().length > 0;
  const box = shown(wideBox) ? wideBox : shown(narrowBar) ? narrowBar : null;
  box?.querySelector("textarea")?.focus({ preventScroll: true });
}

export default function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: task, isLoading } = useTask(id!);
  // A finished task's log, context and steering rows are frozen history: read
  // them once, with no poll and no refetch on window focus or reconnect
  // (`staleTime: Infinity`). Until the task itself loads, hold the poll too,
  // so a finished task never gets a second read. `undefined` keeps each
  // hook's live cadence.
  const taskLive = !!task && !TERMINAL_STATUSES.has(task.status);
  const liveReads = taskLive
    ? undefined
    : task
      ? { refetchInterval: false as const, staleTime: Number.POSITIVE_INFINITY }
      : { refetchInterval: false as const };
  const { data: sessionLogs, isLoading: sessionLogsLoading } = useTaskSessionLogs(id!, liveReads);
  const { data: agents } = useAgents();
  const { data: users } = useUsers();
  const { data: costs, isLoading: costsLoading } = useSessionCosts({ taskId: id });
  const { data: contextData, isLoading: contextLoading } = useTaskContext(id!, liveReads);
  // Steering (≥1.122.1), soft-degrade against older API servers, which 404
  // both `/steer` and `/steering-messages`.
  const steerGate = useFeatureGate("1.122.1");
  const { data: steeringEnabled = true } = useSteeringEnabled();
  const { data: steeringMessages } = useTaskSteeringMessages(id!, {
    enabled: steerGate.supported && steeringEnabled,
    ...liveReads,
  });
  // The tasks this one started (≥1.76.0): `GET /api/sessions/{id}` returns
  // every descendant for any task id. Children can join late (a follow-up, a
  // retry), so it keeps its slow poll after the task finishes.
  const sessionsGate = useFeatureGate("1.76.0");
  const { data: session } = useSession(sessionsGate.supported ? id : undefined);
  // The session this task belongs to: `/sessions/<root id>`, a root task's
  // own. The lineage path is the breadcrumb's fetch (same query key), and
  // its 200 means the caller can read the session. Only an API that serves
  // the sessions v2 view gets the link.
  const sessionsV2Gate = useFeatureGate(SESSIONS_V2_MIN_VERSION);
  const { data: taskPath } = useTaskPath(id);
  const sessionRoot = sessionsV2Gate.supported ? (taskPath?.sessionRoot ?? null) : null;
  // A root task reads its own title live: a rename here shows at once.
  const sessionLink = sessionRoot
    ? {
        href: `/sessions/${sessionRoot.id}`,
        title: sessionDisplayTitle(sessionRoot.id === task?.id ? task : sessionRoot),
      }
    : null;
  // A task that finishes while the page is open gets one last read: the final
  // log lines and context snapshot can land after the previous poll. An
  // invalidation refetches even under `staleTime: Infinity`.
  const queryClient = useQueryClient();
  const wasLiveRef = useRef(false);
  useEffect(() => {
    const wasLive = wasLiveRef.current;
    wasLiveRef.current = taskLive;
    if (!wasLive || taskLive || !task) return;
    for (const part of ["session-logs", "context", "steering-messages"]) {
      void queryClient.invalidateQueries({ queryKey: ["task", task.id, part] });
    }
  }, [taskLive, task, queryClient]);
  // The draft is owned by the page, not the composer. The narrow and wide
  // layouts each mount their own <TaskComposer>, and the wide box moves when
  // the task finishes (the steer box under the log, the follow-up box under
  // the outcome). Holding the text here means crossing the 60rem layout
  // switch, a status flip, or a narrow tab switch does not eat what the user
  // typed.
  const [draft, setDraft] = useState("");
  // The support dialog opens only from "Get help", and gives focus back to it
  // (or to the "..." trigger of the menu that held it) when it closes.
  const [helpOpen, setHelpOpen] = useState(false);
  const helpOpener = useRef<HTMLElement | null>(null);
  // The title's inline rename (`PATCH /api/tasks/{id}/title`, the same call
  // as a session rename). A key that ends it gives the focus back to what
  // shows: the wide layout's pencil, or the narrow layout's "..." trigger.
  const updateTitle = useUpdateSessionTitle();
  const [renaming, setRenaming] = useState(false);
  const refocusAfterRename = useRef(false);
  const pencilRef = useRef<HTMLButtonElement | null>(null);
  const narrowMenuRef = useRef<HTMLButtonElement | null>(null);
  const startRename = useCallback(() => setRenaming(true), []);
  useEffect(() => {
    if (renaming || !refocusAfterRename.current) return;
    refocusAfterRename.current = false;
    const target = [pencilRef.current, narrowMenuRef.current].find(
      (element) => !!element && element.getClientRects().length > 0,
    );
    target?.focus({ preventScroll: true });
  }, [renaming]);
  // A draft, an open dialog and a rename belong to one task: Retry and the
  // spawned task links move this page to another task id.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on a new task id only.
  useEffect(() => {
    setDraft("");
    setHelpOpen(false);
    setRenaming(false);
    refocusAfterRename.current = false;
  }, [id]);
  const { searchParams, setParam } = useUrlSearchState();
  const activeTab = coerceTaskDetailTab(
    readStringParam(searchParams, "tab", DEFAULT_TASK_TAB),
    DEFAULT_TASK_TAB,
  );
  const setActiveTab = useCallback(
    (tab: string) =>
      setParam("tab", coerceTaskDetailTab(tab, DEFAULT_TASK_TAB), {
        defaultValue: DEFAULT_TASK_TAB,
      }),
    [setParam],
  );
  // Transcript or raw log, shared by both layouts.
  const logMode: LogMode =
    readStringParam(searchParams, "log", "transcript") === "raw" ? "raw" : "transcript";
  const setLogMode = useCallback(
    (mode: LogMode) => setParam("log", mode, { defaultValue: "transcript" }),
    [setParam],
  );
  // The details card next to the column folds away, as the app sidebar does.
  const [detailsCollapsed, setDetailsCollapsed] = useLocalToggle(
    "tasks:details-panel-collapsed",
    false,
  );
  // The wide layout's compact bar shows once the hero scrolls out of the
  // center column. One scroller holds the column and the details card: the
  // log flows in it.
  const {
    past: heroScrolledPast,
    scroller: centerScroller,
    scrollerRef: centerScrollerRef,
    sentinelRef: heroEndRef,
  } = useHeroScrolledPast();
  // The wide scroller's height caps the details card, and the message box
  // pinned to its bottom goes to the log as `--log-sticky-bottom`.
  const [wideHeight, wideAreaRef] = useElementHeight();
  const [wideComposerHeight, wideComposerRef] = useElementHeight();
  // The narrow layout scrolls as one above the pinned message box: the hero
  // scrolls away and the tabs stick. Their height goes to the log as
  // `--log-sticky-top`.
  const [narrowScroller, setNarrowScroller] = useState<HTMLElement | null>(null);
  const [narrowHeroHeight, narrowHeroRef] = useElementHeight();
  const [narrowTabsHeight, narrowTabsRef] = useElementHeight();
  const [narrowBar, narrowBarRef] = useState<HTMLElement | null>(null);
  // A tab switch while the tabs are stuck shows the new tab from its top,
  // right under the tabs. With the hero still in view, nothing moves.
  const shownTabRef = useRef(activeTab);
  useLayoutEffect(() => {
    if (shownTabRef.current === activeTab) return;
    shownTabRef.current = activeTab;
    if (narrowScroller && narrowScroller.scrollTop > narrowHeroHeight) {
      narrowScroller.scrollTop = narrowHeroHeight;
    }
  }, [activeTab, narrowScroller, narrowHeroHeight]);
  // "Follow up" focuses the message box: the wide layout's or the narrow
  // layout's, each pinned under its scroller.
  const wideFollowUpBoxRef = useRef<HTMLDivElement | null>(null);
  const requestFollowUp = useCallback(
    () => focusVisibleComposer(wideFollowUpBoxRef.current, narrowBar),
    [narrowBar],
  );
  const actions = useTaskActions(task, {
    onFollowUp: requestFollowUp,
    onGetHelp: (opener) => {
      helpOpener.current = opener;
      setHelpOpen(true);
    },
    onRename: startRename,
    rawLog: logMode === "raw",
    onToggleRawLog: () => setLogMode(logMode === "raw" ? "transcript" : "raw"),
    session: sessionLink?.href ?? null,
  });
  // A follow-up on a finished task is a new task: the page moves to it once
  // it starts. The composer holds a task whose files failed to upload, so the
  // page stays on its retry notice until then.
  const announceFollowUp = useCallback(
    (created: AgentTask) => {
      toast.success("Follow-up task created.");
      void navigate(`/tasks/${created.id}`);
    },
    [navigate],
  );
  const agentNames = useMemo(
    () => new Map((agents ?? []).map((agent) => [agent.id, agent.name])),
    [agents],
  );
  const agentName = task?.agentId ? (agentNames.get(task.agentId) ?? null) : null;
  // Phase 3: read-only "Requested by" lookup. `useUsers()` is shared cache,
  // the identity boot modal already populated it.
  const requestedByUserName = useMemo(() => {
    if (!task?.requestedByUserId || !users) return null;
    return users.find((u) => u.id === task.requestedByUserId)?.name ?? null;
  }, [task, users]);
  // The rail's cache hit, from the session log this page already loads. Only
  // with the log's usage details on.
  const [usageDetails] = useUsageDetails();
  const usageItems = useMemo(
    () => (usageDetails ? normalizeSessionLogs(sessionLogs ?? []).items : null),
    [sessionLogs, usageDetails],
  );
  const callUsage = useMemo(() => (usageItems ? sumItemCallUsage(usageItems) : null), [usageItems]);
  // The transcript's rows: the agent's prose, tool runs, steering and the
  // tasks it delegated, in time order. Task events stay out.
  const transcriptSteering = steerGate.supported && steeringEnabled ? steeringMessages : undefined;
  const delegated = useMemo(
    () =>
      directChildren(id!, session?.chain ?? []).map((child) => ({
        task: child,
        agentName: child.agentId ? (agentNames.get(child.agentId) ?? null) : null,
      })),
    [id, session, agentNames],
  );
  const transcriptRows = useMemo(
    () =>
      buildTranscriptRows({
        messages: parseSessionLogs(sessionLogs ?? []),
        steering: transcriptSteering,
        children: delegated,
      }),
    [sessionLogs, transcriptSteering, delegated],
  );
  // The request composition: the rail's panel and each cache chip's bar.
  // Also only with usage details on.
  const logSessionIds = useMemo(
    () => [...new Set((sessionLogs ?? []).map((log) => log.sessionId))],
    [sessionLogs],
  );
  const { data: manifests } = useRequestComposition(id!, {
    enabled: usageDetails && logSessionIds.length > 0,
    sessionIds: logSessionIds,
    live: taskLive,
  });
  const compositions = useMemo(() => {
    if (!usageItems || !manifests?.length) return null;
    const sessionOfRecord = new Map((sessionLogs ?? []).map((log) => [log.id, log.sessionId]));
    const compactions = (contextData?.snapshots ?? [])
      .filter((snap) => snap.eventType === "compaction")
      .map((snap) => ({ sessionId: snap.sessionId, t: Date.parse(snap.createdAt) }));
    const derived = deriveCallCompositions(
      compositionCallsOf(usageItems, (recId) => sessionOfRecord.get(recId)),
      manifests,
      compactions,
    );
    const latest = manifests.reduce((a, b) =>
      b.createdAt > a.createdAt || (b.createdAt === a.createdAt && b.seq > a.seq) ? b : a,
    );
    const rail = {
      manifest: latest,
      anchor: derived.anchors.get(latest.id),
      sessions: new Set(manifests.map((m) => m.sessionId)).size,
    };
    return { byCall: derived.byCall, rail };
  }, [usageItems, manifests, sessionLogs, contextData]);

  if (isLoading) {
    return (
      <div className="flex-1 min-h-0 space-y-4 p-1">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-8 w-96" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (!task || !actions) {
    return <p className="text-muted-foreground">Task not found.</p>;
  }

  const isTerminal = TERMINAL_STATUSES.has(task.status);

  // Steering reaches any assignee (`canSteerTask`). A finished task gets the
  // follow-up box instead.
  const canSteer = steerGate.supported && steeringEnabled && canSteerTask(task);

  const isFailed = task.status === "failed";
  const hasSessionLogs = sessionLogs && sessionLogs.length > 0;
  const hasOutput = !!task.output;
  const offeredToName = task.offeredTo ? (agentNames.get(task.offeredTo) ?? null) : null;
  const waiting = describeWaiting(task, { agent: agentName, offeredTo: offeredToName });

  // The ids the answer may mention: the session's tasks and the parent.
  const chain = session?.chain ?? [];
  const knownTaskIds = [...chain.map((t) => t.id), task.parentTaskId].filter(
    (taskId): taskId is string => !!taskId && taskId !== task.id,
  );

  // Who, where from, when, cost, files, context and the technical ids, as
  // one card. The wide layout shows it next to the column, the narrow one in
  // its Details tab.
  const renderDetails = (className?: string) => (
    <TaskDetailsRail
      task={task}
      agentName={agentName}
      requestedByName={requestedByUserName}
      costs={costs}
      costsLoading={costsLoading}
      context={contextData}
      contextLoading={contextLoading}
      callUsage={callUsage}
      composition={compositions?.rail}
      session={sessionLink}
      className={className}
    />
  );

  // A failed task's error, always open, with Retry and Get help. "Failed
  // after" names the rail's run time, so the two never disagree.
  const failureCallout = isFailed ? (
    <TaskFailureCallout model={actions} duration={taskRunTime(task, costs)} />
  ) : null;

  // THE MESSAGE BOX, one per layout tree, on the one draft. A finished task
  // follows up: a child task for the same agent (a Slack task answers in the
  // same thread). A live task steers. Any other task has no box.
  const composerProps = isTerminal
    ? {
        targetTask: task,
        canSteer: false,
        followUpAgentId: task.agentId ?? undefined,
        routeLabel: task.agentId ? `Routes to ${agentName ?? "the same agent"}` : undefined,
        value: draft,
        onValueChange: setDraft,
        onCreated: announceFollowUp,
        fullWidth: true,
        className: "px-0 pt-0 pb-0",
      }
    : canSteer
      ? {
          targetTask: task,
          canSteer: true,
          followUpAgentId: task.agentId ?? undefined,
          value: draft,
          onValueChange: setDraft,
          fullWidth: true,
          className: "px-0 pt-0 pb-0",
        }
      : null;

  // THE OUTCOME, the transcript's last message, as a chat app's final reply:
  // the answer as plain text (clamped, with "Show more") and a Copy under it,
  // then a failed task's error with Retry and Get help.
  const answer = hasOutput ? (
    <div data-slot="transcript-outcome" className="min-w-0 px-1">
      <ShowMore>
        <StructuredOutputContent
          citations={task.citations}
          raw={task.output ?? ""}
          maxH=""
          taskIds={knownTaskIds}
        />
      </ShowMore>
      {actions.answer ? (
        <div className="mt-1 -ml-1.5 flex">
          <Tooltip>
            <TooltipTrigger asChild>
              <CopyValueButton
                value={actions.answer}
                label="Copy answer"
                size="icon-xs"
                // A 44 px touch area on touch screens; the row keeps its height.
                className="text-muted-foreground hit-area [--hit-size:44px] hover:text-foreground"
              />
            </TooltipTrigger>
            <TooltipContent side="bottom">Copy answer</TooltipContent>
          </Tooltip>
        </div>
      ) : null}
    </div>
  ) : null;
  const outcome =
    answer || failureCallout ? (
      <>
        {answer}
        {failureCallout}
      </>
    ) : null;

  // STEERING, no longer its own box above the logs. Delivered/handled rows
  // interleave into the SESSION LOGS stream at `deliveredAt`, promoted/
  // cancelled at `createdAt`, and still-pending ones pin to the tail box above
  // the "Agent is working…" footer. `undefined` when gated off, which makes
  // <SessionLogViewer> behave exactly as it did pre-steering.
  const steeringForViewer =
    steerGate.supported && steeringEnabled ? (steeringMessages ?? []) : undefined;
  const hasSteering = (steeringForViewer?.length ?? 0) > 0;

  // Render the viewer whenever there's anything to show, steering-only is a
  // real state right after the first message is queued but before the harness
  // has written any session log lines.
  const showLogViewer = hasSessionLogs || hasSteering;

  // The waiting line: what the task waits for, as plain text.
  const waitingLine = (
    <div className="flex shrink-0 items-center gap-2 px-1">
      <TaskStatusIcon status={task.status} />
      <p className="text-sm text-muted-foreground">{waiting}</p>
    </div>
  );

  // The raw log: every event, with its own toolbar. Each layout passes its
  // scroller as `scrollElement` (the wide column, the narrow root), so the
  // log flows in the page scroller with no scroller of its own. `null` until
  // the scroller mounts. The narrow layout asks for 44 px toolbar controls.
  const renderRawLog = (scrollElement: HTMLElement | null, touchTargets: boolean) =>
    showLogViewer ? (
      <CallCompositionContext.Provider value={compositions?.byCall ?? NO_CALL_COMPOSITIONS}>
        <SessionLogViewer
          logs={sessionLogs ?? []}
          compactionSnapshots={contextData?.snapshots}
          isRunning={taskIsRunning(task.status)}
          steeringMessages={steeringForViewer}
          scrollElement={scrollElement}
          touchTargets={touchTargets}
          status={task.status}
        />
      </CallCompositionContext.Provider>
    ) : sessionLogsLoading ? (
      // Do not claim "no session log" before the read answers.
      <Skeleton className="h-12 w-full shrink-0 rounded-lg" />
    ) : (
      waitingLine
    );

  // The transcript: the same renderer as the Sessions task sheet, with the
  // outcome as its last message (after the waiting line of a run with no rows).
  const hasRows = transcriptRows.length > 0;
  const renderTranscript = (scrollElement: HTMLElement | null) => (
    <>
      <TaskTranscript
        key={task.id}
        task={task}
        rows={transcriptRows}
        scroller={scrollElement}
        outcome={hasRows ? outcome : null}
        outcomeText={task.output ?? undefined}
      />
      {hasRows ? null : (
        <>
          {sessionLogsLoading ? (
            <Skeleton className="h-12 w-full shrink-0 rounded-lg" />
          ) : (
            waitingLine
          )}
          {outcome}
        </>
      )}
    </>
  );

  // No visible heading: the transcript is the column's main view. The
  // "..." menu switches to the raw log.
  const renderSessionLogs = (scrollElement: HTMLElement | null, touchTargets = false) => (
    <section
      aria-label={logMode === "raw" ? "Raw log" : "Transcript"}
      className="flex flex-col gap-3"
    >
      {logMode === "raw" ? (
        <>
          {renderRawLog(scrollElement, touchTargets)}
          {outcome}
        </>
      ) : (
        renderTranscript(scrollElement)
      )}
      <TaskCitationsSection output={task.output ?? ""} citations={task.citations ?? []} />
    </section>
  );

  // The wide layout's live message box: it steers the task. It always shows
  // in the transcript (the raw log hides every message box).
  const steerComposer = composerProps && !isTerminal ? <TaskComposer {...composerProps} /> : null;

  const headerTitle = taskListTitle(task);
  // The server records the model it resolved when the task was claimed
  // (`resolvedModel`, with the layer in `modelSource`). Older tasks and
  // unclaimed ones fall back to the requested `model`, then to whatever the
  // session_costs entries report.
  const displayModel = taskDisplayModel(task) ?? costs?.[0]?.model;
  const displayEffort = taskDisplayEffort(task);
  const creatorName =
    task.creatorAgentId && task.creatorAgentId !== task.agentId
      ? (agentNames.get(task.creatorAgentId) ?? null)
      : null;

  // HERO CHIPS: status, model (with the effort icon when the task records one)
  // and agent, then the tags as plain text. The harness, type, priority and
  // source are in Technical details. In the wide layout the model chip takes
  // focus and its tooltip has the exact model id. The narrow layout shows the
  // plain chip: a 44 px focus target would not fit the chip row, a hover
  // tooltip would cover the tabs under it, and Details lists the model id.
  const modelBadge = displayModel ? (
    <ModelEffortLabel model={displayModel} effort={displayEffort} />
  ) : task.modelTier ? (
    <>
      {modelTierLabel(task.modelTier)} tier
      <EffortMark effort={displayEffort} className="text-muted-foreground" />
    </>
  ) : null;
  // `outline-none`: the chips show the Badge's amber focus ring only, not the
  // browser outline on top of it.
  const modelChipClass = "h-6 max-w-full min-w-0 gap-1.5 px-2 outline-none";
  const wideModelChip = displayModel ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" tabIndex={0} className={modelChipClass}>
          {modelBadge}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="text-left">
        <div className="font-mono">{displayModel}</div>
        {describeModelResolution(task).map((line) => (
          <div key={line}>{line}</div>
        ))}
        {displayEffort ? <div>Effort: {REASONING_EFFORT_LABEL[displayEffort]}</div> : null}
      </TooltipContent>
    </Tooltip>
  ) : modelBadge ? (
    <Badge variant="outline" className={modelChipClass}>
      {modelBadge}
    </Badge>
  ) : null;
  const narrowModelChip = modelBadge ? (
    <Badge variant="outline" className={modelChipClass}>
      {modelBadge}
    </Badge>
  ) : null;
  const agentChip = task.agentId ? (
    <Badge variant="outline" asChild className="h-6 max-w-full gap-1.5 pr-2 pl-0.5 outline-none">
      <Link to={`/agents/${task.agentId}`}>
        <AgentAvatar
          agentId={task.agentId}
          agentName={agentName}
          size="xs"
          className="h-4.5 w-4.5 shadow-none"
        />
        <span className="sr-only">Agent: </span>
        <span className="min-w-0 truncate">{agentName ?? `${task.agentId.slice(0, 8)}…`}</span>
      </Link>
    </Badge>
  ) : null;
  // The cost and the run time as one chip next to the status ("$0.19 in
  // 1m 25s"). The tooltip has the exact figure. No chip without cost rows.
  const totalCost = taskTotalCost(costs);
  const runTime = taskRunTime(task, costs);
  const costChip =
    totalCost != null && totalCost > 0 ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" className="h-6 px-2 font-mono tabular-nums">
            <span className="sr-only">Cost: </span>
            {formatCost(totalCost, { precision: 2 })}
            {runTime ? <span className="font-sans text-muted-foreground">in {runTime}</span> : null}
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="font-mono tabular-nums">
          {formatCost(totalCost, { precision: 4 })}
        </TooltipContent>
      </Tooltip>
    ) : null;

  // The tags as a chip with their count. The list opens in a popover.
  const tagsChip =
    task.tags && task.tags.length > 0 ? (
      <Popover>
        <PopoverTrigger asChild>
          <Badge
            variant="outline"
            asChild
            className="h-6 gap-1 px-2 text-muted-foreground outline-none hit-area [--hit-size:44px] hover:text-foreground"
          >
            <button type="button" aria-label={`Tags (${task.tags.length})`}>
              <Tag aria-hidden />
              <span className="font-mono tabular-nums">{task.tags.length}</span>
            </button>
          </Badge>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-auto max-w-80 p-3">
          <p className="mb-2 text-meta font-medium text-muted-foreground">Tags</p>
          <ul className="flex flex-wrap gap-1.5">
            {task.tags.map((tag) => (
              <li key={tag}>
                <Badge variant="secondary" className="max-w-72 font-normal">
                  <span className="truncate">{tag}</span>
                </Badge>
              </li>
            ))}
          </ul>
        </PopoverContent>
      </Popover>
    ) : null;
  const sourceLine = (
    <TaskSourceLine task={task} requestedByName={requestedByUserName} creatorName={creatorName} />
  );

  // Folds the details card away (and back), next to the app sidebar's own
  // fold. The pick persists per browser. Folded, the column takes the full
  // width.
  const detailsToggle = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={detailsCollapsed ? "Show details" : "Hide details"}
          aria-pressed={!detailsCollapsed}
          onClick={() => setDetailsCollapsed(!detailsCollapsed)}
          className="text-muted-foreground hover:text-foreground"
        >
          {detailsCollapsed ? <PanelRightOpen /> : <PanelRightClose />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {detailsCollapsed ? "Show details" : "Hide details"}
      </TooltipContent>
    </Tooltip>
  );

  // The heading, or the rename field in its place. Only the wide layout
  // shows the pencil: the narrow one renames from its "..." menu.
  const canRename = actions.allowed.action;
  // The field starts with the title as shown (the prompt's title when no
  // title is saved), cut to the server's limit, so saving it unchanged writes
  // nothing and an edited long prompt title still fits.
  const renameStart = headerTitle.slice(0, TITLE_MAX);
  const endRename = (typed: string | null, refocus: boolean) => {
    refocusAfterRename.current = refocus;
    setRenaming(false);
    const next = typed?.trim();
    if (next === undefined) return;
    if (next ? next === renameStart.trim() : !task.title?.trim()) return;
    void saveTitle(task.id, next || null);
  };
  // Optimistic: the heading (and the next rename's "unchanged" check) reads
  // the new title at once. A failure puts the old title back, unless a later
  // rename replaced it. Either way the task is read again. An empty title
  // clears the override: the prompt names the task again.
  const saveTitle = async (taskId: string, title: string | null) => {
    const key = ["task", taskId];
    await queryClient.cancelQueries({ queryKey: key, exact: true });
    const previous = queryClient.getQueryData<TaskWithLogs>(key)?.title;
    const withTitle = (value: string | undefined) => (old: TaskWithLogs | undefined) =>
      old ? { ...old, title: value } : old;
    queryClient.setQueryData<TaskWithLogs>(key, withTitle(title ?? undefined));
    try {
      await updateTitle.mutateAsync({ id: taskId, title });
      toast.success(title ? "Title saved." : "Title cleared.");
    } catch (error) {
      if ((queryClient.getQueryData<TaskWithLogs>(key)?.title ?? null) === title) {
        queryClient.setQueryData<TaskWithLogs>(key, withTitle(previous));
      }
      toast.error(error instanceof Error ? error.message : "Couldn't save the title.");
    } finally {
      void queryClient.invalidateQueries({ queryKey: key, exact: true });
    }
  };
  const renderHeading = (pencil: boolean) =>
    renaming && canRename ? (
      <TaskTitleField
        current={renameStart}
        placeholder={taskListTitle({ task: task.task })}
        onDone={endRename}
      />
    ) : (
      <TaskHeading
        title={headerTitle}
        onRename={canRename ? startRename : undefined}
        pencilRef={pencil ? pencilRef : undefined}
      />
    );

  // WIDE HERO: the title, with the actions and the details fold right of it,
  // then one row: where the task came from on the left, the chips on the
  // right. A narrow column wraps the chips under the source line.
  const wideHero = (
    // `group/title`: a pointer anywhere on the header shows the rename pencil.
    <div className="group/title grid shrink-0 grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-2.5">
      {/* The page's one heading. The breadcrumb truncates the title (and
          collapses to a few characters on a phone), so it cannot carry it. */}
      <div className="min-w-0">{renderHeading(true)}</div>
      <div className="flex items-start justify-end gap-1">
        <TaskActions model={actions} className="justify-end" />
        {detailsToggle}
      </div>
      <div
        data-slot="task-meta-row"
        className="col-span-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2"
      >
        <div className="min-w-0">{sourceLine}</div>
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
          {tagsChip}
          <StatusBadge status={task.status} size="md" />
          {costChip}
          {wideModelChip}
          {agentChip}
        </div>
      </div>
    </div>
  );

  // NARROW HERO: compact, and it scrolls away. A back arrow and the "..."
  // menu (every action but the message box), then the title, and the source
  // line with status, model and tags. The agent is in Details.
  const narrowHero = (
    <div className="flex flex-col gap-1 pb-3">
      <div className="-mx-2 flex items-center justify-between gap-2">
        <Button
          variant="ghost"
          asChild
          className="h-11 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
        >
          <Link to="/tasks">
            <ArrowLeft />
            Tasks
          </Link>
        </Button>
        <TaskActionsMenu model={actions} triggerRef={narrowMenuRef} />
      </div>
      {renderHeading(false)}
      {/* One row: the source line left, the chips right. A phone too narrow
          for both wraps the chips under it. */}
      <div
        data-slot="task-meta-row"
        className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
      >
        <div className="min-w-0 max-w-full">{sourceLine}</div>
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
          <StatusBadge status={task.status} size="md" />
          {costChip}
          {narrowModelChip}
          {tagsChip}
        </div>
      </div>
    </div>
  );

  return (
    // The layout follows the page's own width, not the window's: a docked
    // context panel or an open sidebar can leave a wide window with a narrow
    // page.
    <div className="@container flex flex-col flex-1 min-h-0">
      {isFailed ? (
        <TaskFailureHelpDialog
          task={task}
          open={helpOpen}
          onOpenChange={setHelpOpen}
          returnFocus={helpOpener}
        />
      ) : null}

      {/* Narrow (under 60rem of page width): one scroller from under the app
          header down to the message box, which is pinned under it (it bleeds
          into <main>'s padding). The hero scrolls away and the tabs stick to
          the top. The log flows in this scroller: the tabs' height goes to it
          as a CSS variable, so its toolbar sticks under the tabs. */}
      <div className={cn("@min-[60rem]:hidden flex min-h-0 flex-1 flex-col", MAIN_BLEED)}>
        <div
          ref={setNarrowScroller}
          style={{ "--log-sticky-top": `${narrowTabsHeight}px` } as CSSProperties}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-gutter:stable]"
        >
          <div ref={narrowHeroRef} className={MAIN_GUTTER_X}>
            {narrowHero}
          </div>
          <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 gap-0">
            <div
              ref={narrowTabsRef}
              className={cn(
                "sticky top-0 z-20 border-b border-border-subtle bg-background py-2",
                MAIN_GUTTER_X,
              )}
            >
              <TabsList className="w-full group-data-[orientation=horizontal]/tabs:h-auto">
                <TabsTrigger value="logs" className="h-11">
                  Transcript
                </TabsTrigger>
                <TabsTrigger value="details" className="h-11">
                  Details
                </TabsTrigger>
              </TabsList>
            </div>
            {/* Each panel is a Tab stop (Radix), so it shows the focus ring. */}
            <TabsContent
              value="logs"
              className={cn("flex flex-col gap-3 py-3", MAIN_GUTTER_X, PANEL_FOCUS_RING)}
            >
              {renderSessionLogs(narrowScroller, true)}
            </TabsContent>
            <TabsContent value="details" className={cn("py-3", MAIN_GUTTER_X, PANEL_FOCUS_RING)}>
              {renderDetails()}
            </TabsContent>
          </Tabs>
        </div>
        {composerProps && logMode !== "raw" ? (
          // Pinned under the scroller, on every tab. The raw log is a full-screen
          // debug view, so it has no message box. `env(safe-area-inset-bottom)`
          // keeps the box above the home indicator when the page runs edge to edge.
          <div
            ref={narrowBarRef}
            className={cn(
              "shrink-0 border-t border-border bg-background pt-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)]",
              MAIN_GUTTER_X,
            )}
          >
            <TaskComposer {...composerProps} bar />
          </div>
        ) : null}
      </div>

      {/* Wide: a center column and the details card in one scroller, so its
          scrollbar sits at the right edge of the window. It bleeds into
          <main>'s vertical and right padding (the grid pads back on the
          right). It also reaches 12 px into the left padding and pads back,
          so the title field's border and focus ring, which sit left of the
          text, are not clipped. */}
      <div
        ref={wideAreaRef}
        className={cn(
          "hidden @min-[60rem]:flex flex-1 min-h-0 flex-col -mr-4 md:-mr-6",
          MAIN_BLEED_Y,
        )}
      >
        <div
          ref={centerScrollerRef}
          style={
            {
              "--log-sticky-top": STICKY_BAR_HEIGHT,
              "--log-sticky-bottom": `${wideComposerHeight}px`,
            } as CSSProperties
          }
          className="relative -ml-3 min-h-0 flex-1 overflow-y-auto pl-3 [scrollbar-gutter:stable]"
        >
          <div className="grid min-h-full grid-cols-[minmax(0,1fr)_auto] pr-4">
            <section className="flex min-w-0 flex-col">
              {/* The log's toolbar sticks under the bar. */}
              <TaskStickyBar
                visible={heroScrolledPast}
                title={headerTitle}
                status={task.status}
                model={displayModel}
                effort={displayEffort}
                action={<TaskPrimaryAction model={actions} />}
                onTitleClick={() => scrollToTop(centerScroller)}
              />
              <div className="flex flex-1 flex-col gap-3 pt-6 pr-6 pb-3">
                <div className="pb-2">
                  {wideHero}
                  <div ref={heroEndRef} aria-hidden className="h-px" />
                </div>
                <Separator />

                {/* THE TRANSCRIPT is the main view: the prompt, the run, then the
                    outcome as its last message, as in a chat. It keeps T3 Code's
                    reading width; the header above spans the column. The raw log
                    is wide event rows, so it takes the full column. */}
                <div className={logMode === "raw" ? undefined : CHAT_COLUMN}>
                  {renderSessionLogs(centerScroller)}
                </div>
              </div>
              {composerProps && logMode !== "raw" ? (
                // THE MESSAGE BOX, pinned to the bottom of the scroller under
                // the column: it steers a live task and follows up a finished
                // one. At the end of the log it sits under the last row.
                <div
                  ref={wideComposerRef}
                  className="sticky bottom-0 z-20 bg-background pt-2 pr-6 pb-3"
                >
                  <div className={CHAT_COLUMN}>
                    {isTerminal ? (
                      <div ref={wideFollowUpBoxRef}>
                        <TaskComposer {...composerProps} />
                      </div>
                    ) : (
                      steerComposer
                    )}
                  </div>
                </div>
              ) : null}
            </section>

            {/* The details card is an island next to the column: it sticks to
                the top, level with the title, and scrolls inside when it is
                taller than the scroller. It folds with the collapse pattern
                (DESIGN.md § Motion): width and fade, 200 ms open and 150 ms
                close; reduced motion fades only. The grid's `auto` column
                follows the width, so nothing jumps. */}
            <AnimatedReveal open={!detailsCollapsed} axis="x" className="sticky top-0 self-start">
              <aside
                aria-label="Task details"
                style={{ maxHeight: wideHeight || undefined }}
                className="flex w-80 flex-col pt-6 pb-3"
              >
                {renderDetails("min-h-0 overflow-y-auto")}
              </aside>
            </AnimatedReveal>
          </div>
        </div>
      </div>
    </div>
  );
}
